#!/usr/bin/env python3
"""R56 local Darwin runtime build (this machine only; NOT a release admission).

Inputs (all verified before and after the build):
  - Locked Python environment (R56_VENV, default .build/runtime/venv) — the exact locked packages.
  - R56 acquisition (acquire-002/acquisition.json) — every resource hash-checked.
  - git HEAD must be clean; the commit is recorded in the build receipt.
Output: a fresh <R56_PRIVATE_ROOT>/build-local-NNN/ with dist/runtime/bin and receipt.json.
(scripts/ci-build-macos-runtime.py sets all three inputs; this is what the release uses.)
Usage: $R56_VENV/bin/python scripts/r56-build-local-runtime.py <repo-root>
"""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile, zipfile
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = Path(sys.argv[1]).resolve()  # checkout holding the default .build/runtime
# CI (scripts/ci-build-macos-runtime.py) supplies its own freshly built inputs; the local
# defaults are unchanged.
PRIV = Path(os.environ.get('R56_PRIVATE_ROOT') or REPO / '.build/runtime')
ACQ = Path(os.environ.get('R56_ACQUISITION') or PRIV / 'acquire-002')
VENV = Path(os.environ.get('R56_VENV') or REPO / '.build/runtime/venv')

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()

def fail(m): sys.exit('R56_BUILD_REFUSED: ' + m)

if Path(sys.prefix).resolve() != VENV.resolve(): fail('must run with the R55 installed venv python')
if subprocess.run(['git', 'status', '--porcelain'], cwd=ROOT, capture_output=True, text=True).stdout.strip():
    fail('worktree not clean')
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()

acq = json.loads((ACQ / 'acquisition.json').read_text())
def verify_inputs():
    for f in acq['files']:
        p = ACQ / f['path']
        if p.is_symlink() or sha(p) != f['sha256']: fail('resource drift ' + f['path'])
    for p in sorted((ACQ / 'langcodes').rglob('*')):
        if p.is_file() and p.is_symlink(): fail('symlink ' + str(p))
verify_inputs()
langcodes_hashes = {str(p.relative_to(ACQ)): sha(p) for p in sorted((ACQ / 'langcodes').rglob('*')) if p.is_file()}

n = 1 + max([int(m.group(1)) for d in PRIV.glob('build-local-*') if (m := re.fullmatch(r'build-local-(\d{3})', d.name))] or [0])
out = PRIV / f'build-local-{n:03d}'
out.mkdir(mode=0o700)
stage = out / 'stage'; stage.mkdir(mode=0o700)

# Overlay: full langcodes package (R55 shipped code-only) placed ahead of site-packages.
site = Path(metadata.distribution('langcodes').locate_file(''))
ov = stage / 'overlay'; shutil.copytree(site / 'langcodes', ov / 'langcodes')
for f in ('data_dicts.py', 'language_lists.py'): shutil.copy2(ACQ / 'langcodes' / f, ov / 'langcodes' / f)

# Resources unpacked into the stage, then mapped as PyInstaller datas.
res = stage / 'vendor-resources'
(res / 'misaki/en').mkdir(parents=True)
for f in ('us_gold.json', 'us_silver.json'): shutil.copy2(ACQ / 'misaki/en' / f, res / 'misaki/en' / f)
with zipfile.ZipFile(next((ACQ / 'spacy').glob('*.whl'))) as z:
    z.extractall(stage / 'spacy-whl')
shutil.copytree(stage / 'spacy-whl/en_core_web_sm/en_core_web_sm-3.8.0', res / 'spacy/en_core_web_sm-3.8.0')
assets = stage / 'mlx-assets'; assets.mkdir()
with zipfile.ZipFile(next((ACQ / 'mlx-whisper').glob('*.whl'))) as z:
    for m in z.namelist():
        if m.startswith('mlx_whisper/assets/') and not m.endswith('/'):
            (assets / Path(m).name).write_bytes(z.read(m))
# Kokoro compatibility profile bound to the exact fp16 model bytes (embedded vocab).
import onnxruntime as rt
model = ACQ / 'kokoro/kokoro-v1.0.fp16.onnx'
so = rt.SessionOptions(); so.log_severity_level = 3
vocab = json.loads(rt.InferenceSession(str(model), so, providers=['CPUExecutionProvider']).get_modelmeta().custom_metadata_map['kokoro_config'])['vocab']
(res / 'kokoro').mkdir()
(res / 'kokoro/compatibility.json').write_text(json.dumps({'schemaVersion': 1, 'profiles': [{
    'profileId': 'kokoro-v1_0-fp16', 'modelBytes': model.stat().st_size, 'modelSha256': sha(model), 'vocabSource': 'embedded',
    'vocabCanonicalSha256': hashlib.sha256(json.dumps(sorted(vocab.items()), ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()}]}, indent=1) + '\n')

datas = []
for p in sorted(res.rglob('*')):
    if p.is_file(): datas.append((str(p), str(Path('voice_practice_speech_vendor/resources') / p.parent.relative_to(res))))
for p in sorted(assets.iterdir()): datas.append((str(p), 'mlx_whisper/assets'))
# Same notice/vendor/Metal selection as darwin_bundle.plan, from the installed distributions.
# Distributions excluded from the frozen runtime (r56-local.spec excludes + packaged_stubs)
# ship no files, so their notices are not collected either.
EXCLUDED_DISTRIBUTIONS = {'scipy', 'numba', 'llvmlite'}
for dist in metadata.distributions():
    if (dist.metadata['Name'] or '').lower() in EXCLUDED_DISTRIBUTIONS: continue
    for f in dist.files or ():
        m = str(f)
        if m.endswith('.pth') or m.startswith('..'): continue
        notice = ('.dist-info/' in m and (m.endswith(('METADATA', 'WHEEL')) or '/licenses/' in m)) or Path(m).name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE', 'THIRDPARTYNOTICES'))
        vendor = m.startswith('voice_practice_speech_vendor/') and not m.endswith('.py') and '/resources/' not in m
        metal = m.startswith('mlx/') and m.endswith(('.metallib', '.dylib'))
        if notice or vendor or metal: datas.append((str(dist.locate_file(f)), str(Path(m).parent)))
plan = out / 'plan.json'; plan.write_text(json.dumps({'overlay': str(ov), 'datas': datas}, indent=1))

env = {k: v for k, v in os.environ.items() if k not in ('PYTHONPATH', 'PYTHONHOME')}
env.update(R56_BUILD_PLAN=str(plan), PYTHONDONTWRITEBYTECODE='1', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
           PYINSTALLER_CONFIG_DIR=str(out / 'pyinstaller-cache'), PATH='/usr/bin:/bin:/usr/sbin:/sbin')
subprocess.run([sys.executable, '-I', '-B', '-m', 'PyInstaller', '--noconfirm', '--log-level', 'WARN',
                '--distpath', str(out / 'dist/runtime'), '--workpath', str(out / 'work'),
                str(ROOT / 'spikes/packaged-runtime/r56-local.spec')], cwd=ROOT, env=env, check=True)
verify_inputs()

rt_root = out / 'dist/runtime'
# Normalize for the App's integrity checker (no symlinks, portable names only):
# - PyInstaller top-level dylib aliases become regular copies of their targets;
# - local-version '+' in dist-info names becomes '_' (metadata is read from files, not names);
# - setuptools' vendored jaraco "Lorem ipsum.txt" sample is unused at runtime and dropped.
internal = rt_root / 'bin/_internal'
for p in sorted(internal.iterdir()):
    if p.is_symlink():
        target = p.resolve(strict=True)
        if internal.resolve() not in target.parents: fail('symlink escapes runtime: ' + p.name)
        p.unlink(); shutil.copy2(target, p)
# libmlx resolves mlx.metallib next to its own loaded image. mlx/core.so links
# @rpath/libmlx.dylib with rpath @loader_path/.., so the top-level _internal copies are the
# ones loaded; keep exactly one libmlx.dylib + mlx.metallib there (130+21 MB otherwise doubled).
for name in ('mlx.metallib', 'libmlx.dylib'):
    top, packaged = internal / name, internal / 'mlx/lib' / name
    if packaged.exists():
        if not top.exists(): shutil.move(str(packaged), str(top))
        elif sha(top) == sha(packaged): packaged.unlink()
        else: fail('mlx library copies differ: ' + name)
    if (internal / 'mlx/lib' / name).exists(): fail('DUPLICATE_MLX_LIBRARY ' + name)
# Fail closed if a future mlx layout no longer matches: both libraries must sit at the top
# level and mlx/core.so must still resolve @rpath/libmlx.dylib through @loader_path/.. .
if (internal / 'mlx').exists():
    if not ((internal / 'libmlx.dylib').is_file() and (internal / 'mlx.metallib').is_file()):
        fail('MLX_LIBRARY_LAYOUT missing top-level libmlx.dylib or mlx.metallib')
    core = sorted((internal / 'mlx').glob('core*.so'))
    if len(core) != 1: fail('MLX_LIBRARY_LAYOUT core.so')
    load = subprocess.run(['otool', '-l', str(core[0])], capture_output=True, text=True, check=True).stdout
    links = subprocess.run(['otool', '-L', str(core[0])], capture_output=True, text=True, check=True).stdout
    if 'path @loader_path/.. ' not in load or '@rpath/libmlx.dylib' not in links:
        fail('MLX_LIBRARY_LAYOUT rpath')
# scipy is excluded (packaged_stubs); its private OpenBLAS is not needed (numpy uses
# libscipy_openblas64_). Refuse a tree that still carries scipy.
(internal / 'libscipy_openblas.dylib').unlink(missing_ok=True)
if any((internal / n).exists() for n in ('scipy', 'numba', 'llvmlite')) or list(internal.glob('scipy-*.dist-info')):
    fail('SCIPY_IN_RUNTIME')
for p in sorted(internal.glob('*+*.dist-info')):
    p.rename(p.with_name(p.name.replace('+', '_')))
lorem = internal / 'setuptools/_vendor/jaraco/text/Lorem ipsum.txt'
if lorem.exists(): lorem.unlink()
for d in sorted((p for p in rt_root.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
    if not any(d.iterdir()): d.rmdir()  # inventories list files only; empty dirs are unlisted
bad = [str(p.relative_to(rt_root)) for p in rt_root.rglob('*') if not re.fullmatch(r'[A-Za-z0-9._-]+', p.name)]
links = [str(p.relative_to(rt_root)) for p in rt_root.rglob('*') if p.is_symlink()]
files = {str(p.relative_to(rt_root)): sha(p) for p in sorted(rt_root.rglob('*')) if p.is_file() and not p.is_symlink()}
receipt = {'class': 'R56_LOCAL_SINGLE_MACHINE_NOT_RELEASE', 'commit': commit, 'acquisition': sha(ACQ / 'acquisition.json'),
           'langcodes': langcodes_hashes, 'nonPortableNames': bad, 'symlinks': links, 'fileCount': len(files),
           'treeSha256': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()}
(out / 'receipt.json').write_text(json.dumps(receipt, indent=1) + '\n')
shutil.rmtree(stage); shutil.rmtree(out / 'work')
print(json.dumps({k: receipt[k] for k in ('commit', 'fileCount', 'treeSha256')}), 'nonPortable', len(bad), 'symlinks', len(links))
print('OUTPUT', out)
