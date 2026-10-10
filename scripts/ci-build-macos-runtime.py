#!/usr/bin/env python3
"""Reproducible macOS arm64 voice-runtime build from pinned public sources (CI or a clean Mac).

Inputs are only files committed in this repository:
  - spikes/packaged-runtime/requirements-darwin-arm64-cp311.lock.json (wheels, code sources,
    selected onnxruntime members, patches; every byte pinned by sha256)
  - spikes/packaged-runtime/r56-acquisition.lock.json (runtime resources; sha256 pinned)
Steps: download + verify -> deterministic vendor wheels (darwin_vendor) -> hash-locked offline
install into a fresh uv Python 3.11 venv -> scripts/r56-build-local-runtime.py (PyInstaller).
No speech model is bundled; models are downloaded by the App after install.

Usage: python3 scripts/ci-build-macos-runtime.py /absolute/fresh/work-dir
Prints the runtime build directory on success.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'spikes/packaged-runtime/requirements-darwin-arm64-cp311.lock.json'
ACQ_LOCK = ROOT / 'spikes/packaged-runtime/r56-acquisition.lock.json'
ALLOWED_HOSTS = ('https://files.pythonhosted.org/', 'https://raw.githubusercontent.com/', 'https://github.com/',
                 'https://objects.githubusercontent.com/', 'https://release-assets.githubusercontent.com/')


def fail(message):
    sys.exit('CI_RUNTIME_BUILD_REFUSED: ' + message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class _PinnedRedirects(urllib.request.HTTPRedirectHandler):
    """Every redirect hop must stay on https and on the allowed hosts, not only the last one."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith(ALLOWED_HOSTS):
            fail('redirect hop off the allowed hosts: ' + newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(_PinnedRedirects)


def fetch(url, expected_sha, expected_bytes=None):
    if not url.startswith(ALLOWED_HOSTS[:3]):
        fail('unpinned source host ' + url)
    request = urllib.request.Request(url, headers={'User-Agent': 'voice-practice-ci-runtime'})
    # Transient network errors are retried; the bytes are still verified below.
    for attempt in range(4):
        try:
            with OPENER.open(request, timeout=120) as response:
                if not response.geturl().startswith(ALLOWED_HOSTS):
                    fail('redirected off the allowed hosts: ' + response.geturl())
                body = response.read()
            break
        except (OSError, TimeoutError) as error:
            if attempt == 3:
                fail(f'download failed after retries: {url}: {error}')
            time.sleep(5 * (attempt + 1))
    if sha256(body) != expected_sha or (expected_bytes is not None and len(body) != expected_bytes):
        fail(f'hash mismatch for {url}')
    return body


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'xb') as out:
        out.write(data)


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def main(argv):
    if len(argv) != 2 or not Path(argv[1]).is_absolute():
        fail('usage: ci-build-macos-runtime.py /absolute/fresh/work-dir')
    if sys.platform != 'darwin' or os.uname().machine != 'arm64':
        fail('macOS arm64 required')
    work = Path(argv[1])
    work.mkdir(mode=0o700)
    # The vendor/stage steps refuse symlinked ancestors (macOS /var -> /private/var).
    work = work.resolve(strict=True)
    lock = json.loads(LOCK.read_text())
    acquisition = json.loads(ACQ_LOCK.read_text())

    # 1. Wheels (official PyPI files) and the kokoro-onnx source wheel.
    house = work / 'wheelhouse'
    for wheel in [*lock['wheels'], lock['kokoroSource']]:
        write(house / wheel['filename'], fetch(wheel['url'], wheel['sha256'], wheel['bytes']))

    # 2. Code sources at pinned git revisions, stored under the lock's cache names.
    cache = work / 'cache'
    for source in lock['sources'].values():
        for item in source['source']:
            write(cache / item['cacheFile'], fetch(item['url'], item['sha256'], item['bytes']))

    # 3. onnxruntime: the official wheel (publisher sha256) -> only the reviewed members.
    ort = lock['onnxruntimeCodeSource']
    original = ort['originalWheel']
    wheel_path = work / 'ort-original.whl'
    write(wheel_path, fetch(original['url'], original['sha256'], original['bytes']))
    with zipfile.ZipFile(wheel_path) as archive:
        record = archive.read('onnxruntime-1.22.1.dist-info/RECORD')
        if sha256(record) != ort['originalRecordSha256']:
            fail('onnxruntime RECORD drift')
        write(cache / 'ort-original-RECORD.csv', record)
        for member in ort['selectedMembers']:
            data = archive.read(member['path'])
            if sha256(data) != member['sha256'] or len(data) != member['bytes']:
                fail('onnxruntime member drift ' + member['path'])
            write(cache / 'ort-source' / member['path'], data)
    wheel_path.unlink()

    # 4. Deterministic code-only vendor wheels (onnxruntime, mlx_whisper, langcodes, K/M vendor).
    sys.path.insert(0, str(ROOT / 'spikes/packaged-runtime'))
    vendor = module('darwin_vendor', ROOT / 'spikes/packaged-runtime/darwin_vendor.py')
    local = [w for w in vendor.build(lock, cache, house) if w['name'] != 'r55-build-guard']
    for stray in house.glob('r55_build_guard-*.whl'):
        stray.unlink()

    # 5. Hash-locked, offline, no-deps install into a fresh Python 3.11 venv.
    requirements = work / 'install.lock.txt'
    requirements.write_text(''.join(f"{w['name']}=={w['version']} --hash=sha256:{w['sha256']}\n"
                                    for w in [*lock['wheels'], *local]))
    # The interpreter is frozen into the runtime, so it is pinned by sha256 like every
    # other input (uv would otherwise resolve or download an unpinned build).
    interp = acquisition['pythonInterpreter']
    archive = work / 'python.tar.gz'
    write(archive, fetch(interp['url'], interp['sha256'], interp['bytes']))
    subprocess.run(['/usr/bin/tar', '-xzf', str(archive), '-C', str(work)], check=True)
    archive.unlink()
    python = work / 'python/bin/python3.11'
    reported = subprocess.run([str(python), '-c', 'import platform;print(platform.python_version())'],
                              check=True, capture_output=True, text=True).stdout.strip()
    if reported != interp['version']:
        fail(f'pinned interpreter reports {reported}')
    venv = work / 'venv'
    subprocess.run(['uv', 'venv', '--no-python-downloads', '--python', str(python), str(venv)], check=True)
    subprocess.run(['uv', 'pip', 'install', '--python', str(venv / 'bin/python'), '--offline', '--no-index',
                    '--no-deps', '--require-hashes', '--find-links', str(house), '-r', str(requirements)], check=True)

    # 6. Runtime resources (pinned sha256), then the reviewed PyInstaller build.
    acquire = work / 'acquire'
    for item in acquisition['files']:
        write(acquire / item['path'], fetch(item['url'], item['sha256'], item['bytes']))
    (acquire / 'acquisition.json').write_text(json.dumps({'schemaVersion': 1, 'files': [
        {k: f[k] for k in ('path', 'bytes', 'sha256', 'url', 'license')}
        for f in acquisition['files'] if not f['path'].startswith('langcodes/')]}, indent=1) + '\n')
    private = work / 'builds'
    private.mkdir(mode=0o700)
    env = {**os.environ, 'R56_PRIVATE_ROOT': str(private), 'R56_ACQUISITION': str(acquire), 'R56_VENV': str(venv)}
    env.pop('PYTHONPATH', None)
    subprocess.run([str(venv / 'bin/python'), '-I', str(ROOT / 'scripts/r56-build-local-runtime.py'), str(ROOT)],
                   cwd=ROOT, env=env, check=True)
    build = sorted(private.glob('build-local-*'))[-1]
    shutil.rmtree(house)
    shutil.rmtree(cache)
    print('RUNTIME_BUILD', build)
    print('ACQUISITION', acquire)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
