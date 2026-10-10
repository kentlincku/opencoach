#!/usr/bin/env python3
"""Receipted macOS runtime-only staging; local private builds, not releases."""
import hashlib
import json
import os
import re
import stat
import platform
import subprocess
from contextlib import contextmanager, ExitStack
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 8 * 1024 ** 3


def checked_path(value):
    # Validate the spelling BEFORE pathlib discards dot/empty components. Never
    # repair a caller's token (including POSIX's special double-leading slash).
    raw = os.fspath(value)
    if not isinstance(raw, str) or '\0' in raw:
        raise ValueError('MODEL_PACK_STAGE_UNSAFE_PATH')
    path = Path(raw)
    if path.anchor != '/' or str(path) != raw or '..' in path.parts:
        raise ValueError('MODEL_PACK_STAGE_UNSAFE_PATH')
    for current in reversed([path, *path.parents]):
        if current.is_symlink():
            raise ValueError('MODEL_PACK_STAGE_UNSAFE_LINK: ' + str(current))
    return path


def directory_identities(value):
    # Spelling and symlink checks precede filesystem identity checks. In
    # particular, do not realpath() away evidence of an untrusted ancestor.
    path = checked_path(value)
    identities = {}
    for current in [path, *path.parents]:
        try:
            listed = current.lstat()
        except FileNotFoundError:
            continue  # The exclusive output leaf need not exist yet.
        if stat.S_ISLNK(listed.st_mode):
            raise ValueError('MODEL_PACK_STAGE_UNSAFE_LINK: ' + str(current))
        if not stat.S_ISDIR(listed.st_mode):
            raise ValueError('MODEL_PACK_STAGE_UNSAFE_ROOT: ' + str(current))
        identities[current] = (listed.st_dev, listed.st_ino)
    return identities


def portable(relative):
    if len(relative) > 240 or len(relative.split('/')) > 65:
        raise ValueError('MODEL_PACK_STAGE_UNSAFE_PATH')
    for part in relative.split('/'):
        if (not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', part) or part in ('.', '..')
                or part.endswith('.') or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I)):
            raise ValueError('MODEL_PACK_STAGE_UNSAFE_PATH: ' + relative)
    return relative


def sha256_file(file):
    file = checked_path(file)
    listed = file.lstat()
    if not stat.S_ISREG(listed.st_mode) or listed.st_nlink != 1:
        raise ValueError('MODEL_PACK_STAGE_UNSAFE_FILE: ' + str(file))
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink) != (listed.st_dev, listed.st_ino, listed.st_size, 1):
            raise ValueError('MODEL_PACK_STAGE_UNSAFE_FILE_CHANGED')
        h, size = hashlib.sha256(), 0
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            size += len(block)
            if size > MAX_BYTES:
                raise ValueError('MODEL_PACK_STAGE_UNSAFE_SIZE')
            h.update(block)
        after = os.fstat(stream.fileno())
        if (after.st_size != size or after.st_nlink != 1 or after.st_mtime_ns != opened.st_mtime_ns
                or after.st_ctime_ns != opened.st_ctime_ns or file.lstat().st_ino != opened.st_ino):
            raise ValueError('MODEL_PACK_STAGE_UNSAFE_FILE_CHANGED')
        return h.hexdigest()


def inventory(root):
    root = checked_path(root)
    if not root.is_dir():
        raise ValueError('MODEL_PACK_STAGE_UNSAFE_ROOT')
    files, nodes, total = [], set(), 0

    def visit(directory):
        nonlocal total
        children = sorted(directory.iterdir())
        if not children:
            raise ValueError('MODEL_PACK_STAGE_UNLISTED_DIRECTORY: ' + str(directory))
        for p in children:
            rel = portable(p.relative_to(root).as_posix())
            folded = rel.lower()
            if folded in nodes or len(nodes) >= 8192:
                raise ValueError('MODEL_PACK_STAGE_UNSAFE_COLLISION_OR_LIMIT')
            nodes.add(folded)
            mode = p.lstat().st_mode
            if stat.S_ISLNK(mode):
                raise ValueError('MODEL_PACK_STAGE_UNSAFE_LINK: ' + rel)
            if stat.S_ISDIR(mode):
                visit(p)
            elif stat.S_ISREG(mode):
                size = p.stat().st_size
                total += size
                if total > MAX_BYTES or len(files) >= 4096:
                    raise ValueError('MODEL_PACK_STAGE_UNSAFE_SIZE')
                files.append({'path': rel, 'bytes': size, 'sha256': sha256_file(p)})
            else:
                raise ValueError('MODEL_PACK_STAGE_UNSAFE_FILE: ' + rel)
    visit(root)
    return sorted(files, key=lambda f: f['path'])


def assert_directory_entry(parent_fd, name, fd):
    listed, opened = os.stat(name, dir_fd=parent_fd, follow_symlinks=False), os.fstat(fd)
    if (not stat.S_ISDIR(listed.st_mode) or not stat.S_ISDIR(opened.st_mode)
            or (listed.st_dev, listed.st_ino) != (opened.st_dev, opened.st_ino)):
        raise ValueError('MODEL_PACK_STAGE_DIRECTORY_CHANGED')


def open_directory_at(parent_fd, name):
    listed = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(listed.st_mode):
        raise ValueError('MODEL_PACK_STAGE_UNSAFE_DIRECTORY: ' + name)
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (listed.st_dev, listed.st_ino):
            raise ValueError('MODEL_PACK_STAGE_DIRECTORY_CHANGED')
        assert_directory_entry(parent_fd, name, fd)
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def directory_fd(value, *, anchor=None, create=False):
    """Pin every ancestor; writes use only single names relative to these FDs."""
    path = checked_path(value)
    with ExitStack() as stack:
        if anchor is None:
            fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            stack.callback(os.close, fd)
            parts = path.parts[1:]
        else:
            root, fd = anchor
            parts = path.relative_to(root).parts
            listed, opened = root.lstat(), os.fstat(fd)
            if (not stat.S_ISDIR(listed.st_mode)
                    or (listed.st_dev, listed.st_ino) != (opened.st_dev, opened.st_ino)):
                raise ValueError('MODEL_PACK_STAGE_DIRECTORY_CHANGED')
        links = []
        for part in parts:
            if create:
                try:
                    os.stat(part, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
            child = open_directory_at(fd, part)
            stack.callback(os.close, child)
            links.append((fd, part, child))
            fd = child
        yield fd
        for link in links:
            assert_directory_entry(*link)


@contextmanager
def private_output(value, *, anchor=None):
    out = checked_path(value)
    if not out.parent.is_dir():
        raise ValueError('MODEL_PACK_STAGE_OUTPUT_PARENT_REQUIRED')
    with directory_fd(out.parent, anchor=anchor) as parent_fd:
        try:
            os.mkdir(out.name, mode=0o700, dir_fd=parent_fd)
        except FileExistsError:
            raise ValueError('MODEL_PACK_STAGE_OUTPUT_EXISTS') from None
        fd = open_directory_at(parent_fd, out.name)
        try:
            yield out, fd
            assert_directory_entry(parent_fd, out.name, fd)
        finally:
            os.close(fd)


def exclusive_directory(value, *, anchor=None):
    with private_output(value, anchor=anchor) as (out, _fd):
        return out


def assert_no_speech_models(files):
    # Do NOT blanket-strip *_internal/*/resources, *.bin, spaCy, or dictionaries.
    # The fixed MLX/Kokoro profile keeps its G2P stack; only speech payloads are forbidden.
    for file in files:
        name = Path(file['path']).name.lower()
        if name.endswith(('.onnx', '.safetensors', '.gguf', '.ggml', '.tflite')) or re.fullmatch(r'voices(?:-v[0-9.]+)?\.bin', name):
            raise ValueError('MODEL_PACK_STAGE_EMBEDDED_SPEECH_MODEL: ' + file['path'])


def file_state(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_nlink, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def copy_runtime(verified, asset_root, *, anchor=None):
    import shutil
    assert_no_speech_models(verified['files'])
    if inventory(verified['root']) != verified['files']:
        raise ValueError('MODEL_PACK_STAGE_RUNTIME_INPUT_CHANGED')
    with private_output(asset_root, anchor=anchor) as (out, root_fd):
        for file in verified['files']:
            source = verified['root'] / file['path']
            target = out / 'runtime' / file['path']
            with directory_fd(target.parent, anchor=(out, root_fd), create=True) as parent_fd:
                # A pathname swap cannot redirect a write or chmod: the source
                # is no-follow and the exclusive target is relative to a held
                # directory, never to a mutable full destination pathname.
                listed = checked_path(source).lstat()
                fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    with os.fdopen(fd, 'rb', closefd=False) as incoming:
                        st = os.fstat(fd)
                        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                            raise ValueError('MODEL_PACK_STAGE_UNSAFE_FILE')
                        if file_state(st) != file_state(listed) or st.st_size != file['bytes']:
                            raise ValueError('MODEL_PACK_STAGE_UNSAFE_FILE_CHANGED')
                        mode = 0o700 if st.st_mode & 0o111 else 0o600
                        with exclusive_file_at(parent_fd, target.name, mode) as outgoing:
                            shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
                            if (outgoing.tell() != file['bytes'] or file_state(os.fstat(fd)) != file_state(st)
                                    or file_state(checked_path(source).lstat()) != file_state(st)):
                                raise ValueError('MODEL_PACK_STAGE_UNSAFE_FILE_CHANGED')
                finally:
                    os.close(fd)
        if inventory(out / 'runtime') != verified['files'] or inventory(verified['root']) != verified['files']:
            raise ValueError('MODEL_PACK_STAGE_RUNTIME_INPUT_CHANGED')
        return out


def adhoc_public_build():
    # Unsigned public pre-release (no Developer ID): ad-hoc signatures, explicitly opted in.
    return os.environ.get('VOICE_PUBLIC_ADHOC_BUILD') == '1'


def sign_runtime(asset_root, identity, entitlements):
    adhoc = identity == '-' and adhoc_public_build()
    if not isinstance(identity, str) or not identity.strip() or (identity.strip() == '-' and not adhoc):
        raise ValueError('MODEL_PACK_STAGE_SIGN_IDENTITY_REQUIRED: set R56_SIGN_IDENTITY')
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise ValueError('MODEL_PACK_STAGE_MAC_ARM64_REQUIRED')
    asset_root, entitlements = checked_path(asset_root), checked_path(entitlements)
    entitlements_sha = sha256_file(entitlements)
    # Full safe scan before opening any candidate; never sign the external input.
    files = inventory(asset_root)
    magics = {bytes.fromhex(m) for m in ['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface',
                                        'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']}
    machos = []
    for file in files:
        with (asset_root / file['path']).open('rb') as stream:
            if stream.read(4) in magics:
                machos.append(file['path'])
    entry = 'runtime/bin/voice-runtime'
    if entry not in machos or not (asset_root / entry).stat().st_mode & 0o111:
        raise ValueError('MODEL_PACK_STAGE_MACHO_ENTRY_REQUIRED')
    commands = []

    def run(argv):
        result = subprocess.run(argv, capture_output=True, timeout=120)
        commands.append({'command': argv, 'exitCode': result.returncode,
                         'stdout': result.stdout.decode('utf-8', errors='replace'),
                         'stderr': result.stderr.decode('utf-8', errors='replace')})
        if result.returncode:
            error = ValueError('MODEL_PACK_STAGE_SIGN_COMMAND_FAILED')
            error.commands = commands
            raise error
    for rel in sorted(machos, key=lambda name: (name == entry, name)):
        full = str(asset_root / rel)
        run(['/usr/bin/lipo', full, '-verify_arch', 'arm64'])  # documented order; newer lipo enforces it
        # Ad-hoc code has no Team ID, so hardened-runtime library validation would refuse
        # its own dylibs; the public ad-hoc build signs without the runtime option.
        args = ['/usr/bin/codesign', '--force', '--timestamp=none', *([] if adhoc else ['--options', 'runtime']), '--sign', identity]
        if rel == entry and not adhoc:
            args += ['--entitlements', str(entitlements)]
        run(args + [full])
    for rel in sorted(machos):
        run(['/usr/bin/codesign', '--verify', '--strict', str(asset_root / rel)])
    if sha256_file(entitlements) != entitlements_sha:
        raise ValueError('MODEL_PACK_STAGE_ENTITLEMENTS_CHANGED')
    return {'status': 'PASS', 'identity': 'adhoc' if adhoc else identity, 'entitlementsSha256': entitlements_sha,
            'files': sorted(machos), 'commands': commands}


def read_json(file):
    file = checked_path(file)
    digest = sha256_file(file)
    if file.stat().st_size > 4 * 1024 ** 2:
        raise ValueError('MODEL_PACK_STAGE_METADATA_LIMIT')
    data = file.read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('MODEL_PACK_STAGE_METADATA_CHANGED')

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('MODEL_PACK_STAGE_DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)


def verify_acquisition(acquisition, receipt):
    acquisition = checked_path(acquisition)
    manifest = acquisition / 'acquisition.json'
    digest = sha256_file(manifest)
    if digest != receipt['acquisition']:
        raise ValueError('MODEL_PACK_STAGE_ACQUISITION_MANIFEST_CHANGED')
    data = read_json(manifest)
    if data.get('schemaVersion') != 1 or not isinstance(data.get('files'), list) or not data['files']:
        raise ValueError('MODEL_PACK_STAGE_ACQUISITION_SCHEMA')
    wanted = {}
    for file in data['files']:
        rel = portable(file['path'])
        if rel in wanted or type(file.get('bytes')) is not int or not 0 <= file['bytes'] <= MAX_BYTES:
            raise ValueError('MODEL_PACK_STAGE_ACQUISITION_SCHEMA')
        wanted[rel] = {'path': rel, 'bytes': file['bytes'], 'sha256': file['sha256']}
    for rel, sha in receipt['langcodes'].items():
        portable(rel)
        expected = {'path': rel, 'bytes': (acquisition / rel).stat().st_size, 'sha256': sha}
        if rel in wanted and wanted[rel] != expected:
            raise ValueError('MODEL_PACK_STAGE_ACQUISITION_SCHEMA')
        wanted[rel] = expected
    for rel, expected in wanted.items():
        file = acquisition / rel
        if (not isinstance(expected['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', expected['sha256'])
                or sha256_file(file) != expected['sha256'] or file.stat().st_size != expected['bytes']):
            raise ValueError('MODEL_PACK_STAGE_ACQUISITION_FILE_CHANGED: ' + rel)
    return {'path': str(acquisition), 'manifestSha256': digest, 'files': sorted(wanted.values(), key=lambda f: f['path'])}


def verify_runtime(build, expected_commit):
    build = checked_path(build)
    receipt_file = build / 'receipt.json'
    receipt = read_json(receipt_file)
    receipt_sha = sha256_file(receipt_file)
    is_sha = lambda value: isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value)
    if (not isinstance(receipt, dict)
            or receipt.get('class') != 'R56_LOCAL_SINGLE_MACHINE_NOT_RELEASE'
            or not isinstance(receipt.get('commit'), str)
            or not re.fullmatch(r'[0-9a-f]{40}', receipt['commit'])
            or not is_sha(receipt.get('treeSha256')) or not is_sha(receipt.get('acquisition'))
            or type(receipt.get('fileCount')) is not int or not 0 < receipt['fileCount'] <= 4096
            or receipt.get('symlinks') != [] or receipt.get('nonPortableNames') != []
            or not isinstance(receipt.get('langcodes'), dict)):
        raise ValueError('MODEL_PACK_STAGE_RECEIPT_INVALID')
    if receipt['commit'] != expected_commit:
        raise ValueError('MODEL_PACK_STAGE_SOURCE_COMMIT_MISMATCH: rebuild runtime at the current clean HEAD')
    root = build / 'dist/runtime'
    files = inventory(root)
    old_map = {f['path']: f['sha256'] for f in files}
    tree_sha = hashlib.sha256(json.dumps(old_map, sort_keys=True).encode()).hexdigest()
    if tree_sha != receipt['treeSha256'] or len(files) != receipt['fileCount']:
        raise ValueError('MODEL_PACK_STAGE_RUNTIME_RECEIPT_MISMATCH')
    if sha256_file(receipt_file) != receipt_sha:
        raise ValueError('MODEL_PACK_STAGE_METADATA_CHANGED')
    return {'root': root, 'receipt': receipt, 'receiptSha256': receipt_sha, 'files': files}


def node_value(expression, payload=None):
    # Share the actual desktop canonicalizers/validators; no reimplementation of
    # JS manifest digests and no options.trust/test-only authority in native pack.
    script = ROOT / 'scripts/macos-pack-model-packs.cjs'
    code = ("const fs=require('node:fs');const pack=require(process.argv[1]);"
            "const input=JSON.parse(fs.readFileSync(0,'utf8'));"
            "process.stdout.write(JSON.stringify(" + expression + "));")
    result = subprocess.run(['node', '-e', code, str(script)], input=json.dumps(payload).encode(),
                            capture_output=True, timeout=120, cwd=ROOT)
    if result.returncode:
        raise ValueError('MODEL_PACK_STAGE_NODE_VALIDATION: ' + result.stderr.decode('utf-8', errors='replace'))
    return json.loads(result.stdout)


def source_snapshot():
    return node_value('pack.sourceSnapshot(input)', str(ROOT))


@contextmanager
def exclusive_file_at(parent_fd, name, mode=0o600):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent_fd)
    try:
        created = os.fstat(fd)

        def validate(size, expected_mode):
            opened = os.fstat(fd)
            listed = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if (not stat.S_ISREG(opened.st_mode) or not stat.S_ISREG(listed.st_mode)
                    or opened.st_nlink != 1 or listed.st_nlink != 1
                    or (opened.st_dev, opened.st_ino) != (created.st_dev, created.st_ino)
                    or (listed.st_dev, listed.st_ino) != (created.st_dev, created.st_ino)
                    or opened.st_size != size or stat.S_IMODE(opened.st_mode) != expected_mode):
                raise ValueError('MODEL_PACK_STAGE_UNSAFE_FILE_CHANGED')

        validate(0, stat.S_IMODE(created.st_mode))
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            yield stream
            stream.flush()
            validate(stream.tell(), mode)
    finally:
        os.close(fd)


def write_private(file, data, *, anchor=None):
    file = checked_path(file)
    with directory_fd(file.parent, anchor=anchor, create=True) as parent_fd:
        with exclusive_file_at(parent_fd, file.name) as stream:
            stream.write(data)


def write_json(file, value, *, anchor=None):
    write_private(file, (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode(), anchor=anchor)


def tree_digest(files):
    return hashlib.sha256(''.join(f"{f['path']}:{f['bytes']}:{f['sha256']}\n" for f in files).encode()).hexdigest()


def stage(runtime_build, acquisition, output):
    runtime_build, acquisition, output = map(checked_path, [runtime_build, acquisition, output])
    output_ids = directory_identities(output)
    for readonly in [ROOT, runtime_build, acquisition]:
        input_ids = directory_identities(readonly)
        if (output == readonly or readonly in output.parents or output in readonly.parents
                or input_ids.get(readonly) in output_ids.values()
                or output_ids.get(output) in input_ids.values()):
            raise ValueError('MODEL_PACK_STAGE_OUTPUT_OVERLAPS_INPUT')
    source = source_snapshot()  # Current committed HEAD, never a hard-coded base.
    runtime = verify_runtime(runtime_build, source['commit'])
    acquired = verify_acquisition(acquisition, runtime['receipt'])
    catalog_file = ROOT / 'resources/macos-model-packs.json'
    entitlements = ROOT / 'build/entitlements.runtime.plist'
    catalog = read_json(catalog_file)
    input_hashes = {'catalog': {'path': 'resources/macos-model-packs.json', 'sha256': sha256_file(catalog_file)},
                    'entitlements': {'path': 'build/entitlements.runtime.plist', 'sha256': sha256_file(entitlements)}}
    with private_output(output) as anchor:
        out, _output_fd = anchor
        try:
            resources = exclusive_directory(out / 'resources', anchor=anchor)
            assets = copy_runtime(runtime, resources / 'voice-assets', anchor=anchor)
            signing = sign_runtime(assets, os.environ.get('R56_SIGN_IDENTITY'), entitlements)
            # The only published inventory/root is built from the POST-sign bytes.
            files = inventory(assets)
            metadata = node_value('pack.deriveStageMetadata(input.catalog,input.files)', {'catalog': catalog, 'files': files})
            compiled = node_value('pack.compiledTrustBytes(input).toString("utf8")', metadata['trust'])
            write_json(resources / 'voice-assets-inventory.json', {'files': files}, anchor=anchor)
            write_json(resources / 'manifests/model-manifest.json', metadata['modelManifest'], anchor=anchor)
            write_json(resources / 'manifests/speech-model-capabilities.json', metadata['capabilities'], anchor=anchor)
            for file in sorted((ROOT / 'resources').glob('*.json')):
                # Platform catalogs are build inputs, never App manifests.
                if file.name not in ('macos-model-packs.json', 'windows-model-packs.json', 'model-manifest.json', 'speech-model-capabilities.json'):
                    # Preserve the other reviewed resource manifests byte for byte.
                    sha256_file(file)
                    write_private(resources / 'manifests' / file.name, file.read_bytes(), anchor=anchor)
            write_json(out / 'trust.json', metadata['trust'], anchor=anchor)
            write_private(out / 'bundled-voice-trust.cjs', compiled.encode(), anchor=anchor)
            write_json(out / 'source.json', source, anchor=anchor)
            write_json(out / 'signing.json', signing, anchor=anchor)
            if (source_snapshot() != source or verify_runtime(runtime_build, source['commit']) != runtime
                    or verify_acquisition(acquisition, runtime['receipt']) != acquired
                    or sha256_file(catalog_file) != input_hashes['catalog']['sha256']
                    or sha256_file(entitlements) != input_hashes['entitlements']['sha256']):
                raise ValueError('MODEL_PACK_STAGE_INPUT_CHANGED')
            staged_files = inventory(out)
            receipt = {'schemaVersion': 1, 'class': 'MACOS_RUNTIME_ONLY_LOCAL_NOT_RELEASE', 'operation': 'STAGE', 'status': 'PASS',
                       'source': {key: source[key] for key in ('commit', 'gitTree', 'treeSha256')},
                       'runtimeInput': {'buildDirectory': str(runtime_build), 'receiptSha256': runtime['receiptSha256'],
                                        'commit': runtime['receipt']['commit'], 'treeSha256': runtime['receipt']['treeSha256'],
                                        'fileCount': runtime['receipt']['fileCount']},
                       'acquisition': acquired, 'inputs': input_hashes,
                       'signing': {key: signing[key] for key in ('status', 'identity', 'files', 'entitlementsSha256')},
                       'treeDigest': metadata['trust']['treeDigest'], 'runtimeTreeDigest': metadata['trust']['runtimeTreeDigest'],
                       'fileCount': metadata['trust']['fileCount'], 'stageTreeDigest': tree_digest(staged_files),
                       'files': staged_files, 'appAcceptance': 'NOT_RUN'}
            write_json(out / 'receipt.json', receipt, anchor=anchor)
            return {'type': 'MACOS_MODEL_PACKS_STAGE', 'receiptPath': str(out / 'receipt.json'),
                    'receiptSha256': sha256_file(out / 'receipt.json'), 'sourceCommit': source['commit'],
                    'treeDigest': receipt['treeDigest'], 'fileCount': receipt['fileCount']}
        except BaseException as error:
            write_json(out / 'failure.json', {'status': 'FAILED', 'error': str(error),
                                             'commands': getattr(error, 'commands', []), 'appAcceptance': 'NOT_RUN'}, anchor=anchor)
            raise


def main(argv=None):
    import argparse
    import sys
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    # Keep raw tokens until checked_path; type=Path would erase bad spellings.
    parser.add_argument('--runtime-build', required=True, help='absolute R56 build directory; same clean HEAD')
    parser.add_argument('--acquisition', required=True, help='absolute read-only R56 acquire directory')
    parser.add_argument('--output', required=True, help='fresh absolute private directory outside all inputs')
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        result = stage(args.runtime_build, args.acquisition, args.output)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        for command in getattr(error, 'commands', [])[-1:]:
            # Only the failing signing command: argv, exit code and its stderr.
            print(json.dumps({k: command[k] for k in ('command', 'exitCode', 'stderr')}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
