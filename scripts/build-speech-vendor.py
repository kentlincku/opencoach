#!/usr/bin/env python3
"""Offline private CODE-ONLY K/M/F wheel builder (stdlib, no installs/network).

These audited member hashes bind selected official immutable source bytes, not
caller-editable manifests or folder names. This is NOT an S4 runtime builder.
Unpinned external Requires-Dist entries describe imports, NOT a release lock.
"""
import argparse
import ast
import base64
import csv
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile

ROOT = 'voice_practice_speech_vendor'
VERSION = '0.1.0+kmf.v1'
K_SHA = '50c8de4950d601df41428ee5462a48c8a78bef441bf671f2492e070ef44d8a32'
K_URL = 'https://files.pythonhosted.org/packages/60/e1/a27e5a70a525a5ee1fd5357596f07b724d02ff317f134e86cb6e3d9db968/kokoro_onnx-0.6.1-py3-none-any.whl'
PINS = {
    'misaki': {
        'revision': 'e820629b96334db28227df37f280e4836d46fadb',
        'repository': 'https://github.com/hexgrad/misaki',
        'members': {
            'LICENSE': 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
            'misaki/__init__.py': '3ebbe9b05a7115f57ef4291eaea1fcc3d6a3ee3a78e19ce5436d855dfe483889',
            'misaki/en.py': 'ddf67ad3bc4dd98143dcc9b6fbcde259b9d879d8b91684201cf0deeb07aa9910',
            'misaki/token.py': '5ff6ce45da6766cdc1e3d5c91b0b2b093d912b8df6f2da327af56f88ad43f073',
            'pyproject.toml': 'e52e3283a3f748be921081481417e45dbffdd67b4486ff9d0fba741d00ded5c2',
        },
    },
    'faster-whisper': {
        'revision': '65882eee9f5cdbeeb2d877f1131d48cf241b327d',
        'repository': 'https://github.com/SYSTRAN/faster-whisper',
        'members': {
            'LICENSE': 'af6798135e729f8aa6c853936d037dfdea449734d26b8ea6a89805fca758c0d5',
            'faster_whisper/__init__.py': '5396c3a025a7b0cf81246fcd680c0bb7e384e2e587cc2e18f9518cef4c26d56c',
            'faster_whisper/audio.py': '60a1d8638f718cbf6d245aed3e5a5aa61c1f822a0b0fe9b48a7c928d47c23909',
            'faster_whisper/feature_extractor.py': 'e403966dbc592a53695eea2aea24fa60bab50ef6755e0076b311f907be7a397c',
            'faster_whisper/tokenizer.py': '614a96b6a9660096e4f4e9fbe8860cd75ad250dce8e85a847998a3d6d48165d2',
            'faster_whisper/transcribe.py': '5d5ffb00018561d3d529b2c72e1d9f5fff055bea725f3cccc7c6c67f5cc8ffe4',
            'faster_whisper/utils.py': '5b36ceb9d0fd3961de8cfb144bd82f9a4ef3151b2e5958405a11efb4f3ac4f82',
            'faster_whisper/vad.py': '37a9c774aefdd3162d936b896c8dcf5571b2ed938d65bffecfd631770049a18d',
            'faster_whisper/version.py': '70ee45276562706d9787f105fb3010417fa9621fe6a9e2fad01a209f3044d9c5',
            'requirements.txt': '0a72226dc3d5cccb0d4908add58637a93546d9813ea498e41480d63237050a30',
        },
    },
}
PATCHES = {
    'kokoro-onnx-0.6.1-explicit-tokenizer.patch': {'kokoro_onnx/'+n for n in ('__init__.py','config.py','session.py','tokenizer.py')},
    'misaki-e820629-offline-injection.patch': {'misaki/en.py'},
    'faster-whisper-1.2.1-array-only.patch': {'faster_whisper/'+n for n in ('audio.py','transcribe.py','vad.py')} | {'requirements.txt'},
}
EXTERNAL = {'numpy', 'onnxruntime', 'addict', 'regex', 'ctranslate2', 'tokenizers', 'huggingface_hub', 'tqdm'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(data):
    return (json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2)+'\n').encode('utf-8')


def safe_name(name):
    if not isinstance(name, str) or not name or len(name) > 240 or '\\' in name or ':' in name or '\x00' in name:
        raise ValueError('MALFORMED_SOURCE_PATH')
    if any(part in ('', '.', '..') for part in name.split('/')) or PurePosixPath(name).is_absolute():
        raise ValueError('MALFORMED_SOURCE_PATH')
    return name


def no_symlinks(path):
    if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('MALFORMED_SOURCE_PATH')


def bounded_read(path, maximum=2*1024*1024):
    no_symlinks(path)
    if not path.is_file() or path.stat().st_size > maximum:
        raise ValueError('SOURCE_MEMBER_INVALID')
    with path.open('rb') as source:
        data = source.read(maximum+1)
    if len(data) > maximum:
        raise ValueError('SOURCE_MEMBER_INVALID')
    return data


def read_tree(path, pin):
    no_symlinks(path)
    if not path.is_dir():
        raise ValueError('SOURCE_TREE_REQUIRED')
    # Do not follow directory links; reject extra/hidden files and special entries.
    actual = set()
    pending = [path]
    expected_dirs = {str(PurePosixPath(n).parent) for n in pin['members']} - {'.'}
    while pending:
        for child in pending.pop().iterdir():
            name = safe_name(child.relative_to(path).as_posix())
            if child.is_symlink():
                raise ValueError('MALFORMED_SOURCE_PATH')
            if child.is_dir():
                if name not in expected_dirs:
                    raise ValueError('SOURCE_MEMBER_SET_MISMATCH')
                pending.append(child)
            else:
                actual.add(name)
                if len(actual) > len(pin['members']):
                    raise ValueError('SOURCE_MEMBER_SET_MISMATCH')
    if actual != set(pin['members']):
        raise ValueError('SOURCE_MEMBER_SET_MISMATCH')
    result = {}
    for name, expected in pin['members'].items():
        data = bounded_read(path/name)
        if sha(data) != expected:
            raise ValueError('SOURCE_HASH_MISMATCH')
        result[name] = data
    return result


def read_kokoro(path):
    data = bounded_read(path)
    if sha(data) != K_SHA:
        raise ValueError('SOURCE_HASH_MISMATCH')
    result = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for member in archive.infolist():
            name = safe_name(member.filename)
            mode = member.external_attr >> 16
            if name in result or member.file_size > 2*1024*1024 or stat.S_ISLNK(mode):
                raise ValueError('SOURCE_MEMBER_INVALID')
            result[name] = archive.read(member)
    return result


def apply_patch(files, patch, allowed):
    """Exact positions, counts, old bytes and paths; no fuzz, offset, subprocess."""
    lines = patch.decode('utf-8').splitlines(keepends=True)
    i = 0
    changed = set()
    hunks = []
    while i < len(lines):
        if not lines[i].startswith('--- a/'):
            raise ValueError('PATCH_INVALID')
        name = safe_name(lines[i][6:].rstrip('\n'))
        if name not in allowed or name in changed or name not in files or i+1 >= len(lines) or lines[i+1] != '+++ b/'+name+'\n':
            raise ValueError('PATCH_PATH_INVALID')
        changed.add(name); i += 2
        old = files[name].decode('utf-8').splitlines(keepends=True)
        out, cursor, count = [], 0, 0
        while i < len(lines) and lines[i].startswith('@@ '):
            match = re.fullmatch(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\n', lines[i])
            if not match:
                raise ValueError('PATCH_INVALID')
            start, old_count, new_start, new_count = (int(match[1]), int(match[2] or 1), int(match[3]), int(match[4] or 1))
            start = start-1 if old_count else start
            if not cursor <= start <= len(old):
                raise ValueError('PATCH_POSITION_MISMATCH')
            out.extend(old[cursor:start]); cursor = start
            if (new_start-1 if new_count else new_start) != len(out):
                raise ValueError('PATCH_POSITION_MISMATCH')
            i += 1; before, after = [], []
            while i < len(lines) and lines[i][:1] in (' ', '+', '-') and not lines[i].startswith('--- a/'):
                line = lines[i]; i += 1
                if line[0] in ' -': before.append(line[1:])
                if line[0] in ' +': after.append(line[1:])
            if len(before) != old_count or len(after) != new_count or old[cursor:cursor+old_count] != before:
                raise ValueError('PATCH_CONTEXT_MISMATCH')
            out.extend(after); cursor += old_count; count += 1
            hunks.append({'member':name, 'oldStart':start, 'oldCount':old_count, 'newCount':new_count})
        if not count:
            raise ValueError('PATCH_EMPTY')
        out.extend(old[cursor:]); files[name] = ''.join(out).encode('utf-8')
    if changed != allowed:
        raise ValueError('PATCH_MEMBER_SET_MISMATCH')
    return hunks


def relocate(name, data, members):
    """Only F absolute imports move. Every import edge is audited before output."""
    tree = ast.parse(data, filename=name)
    edits, changes, imports = [], [], []
    lines = data.splitlines(keepends=True)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if (isinstance(func, ast.Name) and func.id in ('__import__','eval','exec')) or (isinstance(func, ast.Attribute) and func.attr == 'import_module'):
                raise ValueError('UNRESOLVED_DYNAMIC_IMPORT')
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        if isinstance(node, ast.ImportFrom):
            module = node.module or ''
            if node.level:
                parts = list(PurePosixPath(name).parent.parts)
                if node.level > len(parts): raise ValueError('UNEXPECTED_IMPORT_ROOT')
                module = '.'.join(parts[:len(parts)-node.level+1] + ([module] if module else []))
            roots = [module]
        else:
            roots = [alias.name for alias in node.names]
        for module in roots:
            root = module.split('.')[0]
            if root in ('kokoro_onnx','misaki','faster_whisper'):
                target = module.replace('.', '/')
                if target+'.py' not in members and target+'/__init__.py' not in members:
                    raise ValueError('UNRESOLVED_IMPORT_MEMBER')
                if not isinstance(node, ast.ImportFrom) or not node.level:
                    if root != 'faster_whisper' or not name.startswith('faster_whisper/') or not isinstance(node, ast.ImportFrom):
                        raise ValueError('UNEXPECTED_IMPORT_ROOT')
                    original_module = node.module
                    node.module = ROOT+'.'+original_module
                    start = sum(map(len, lines[:node.lineno-1]))+node.col_offset
                    end = sum(map(len, lines[:node.end_lineno-1]))+node.end_col_offset
                    edits.append((start,end,ast.unparse(node).encode()))
                    changes.append({'line':node.lineno,'from':original_module,'to':node.module})
            elif root not in EXTERNAL and root not in sys.stdlib_module_names:
                raise ValueError('UNEXPECTED_IMPORT_ROOT')
            imports.append(module)
    for start,end,replacement in sorted(edits,reverse=True):
        data = data[:start]+replacement+data[end:]
    ast.parse(data, filename=name)
    return data, changes, sorted(set(imports))


def build(kokoro_source, misaki_source, faster_whisper_source, output_dir):
    output_dir = Path(output_dir)
    no_symlinks(output_dir)
    if output_dir.exists(): raise ValueError('OUTPUT_EXISTS')
    sources = {'kokoro-onnx':read_kokoro(Path(kokoro_source)),
               'misaki':read_tree(Path(misaki_source),PINS['misaki']),
               'faster-whisper':read_tree(Path(faster_whisper_source),PINS['faster-whisper'])}
    for source in (Path(kokoro_source).parent, Path(misaki_source), Path(faster_whisper_source)):
        if output_dir == source or source in output_dir.parents:
            raise ValueError('OUTPUT_INSIDE_SOURCE')
    files = {name:data for group in sources.values() for name,data in group.items() if name.endswith('.py') or name == 'requirements.txt'}
    before = dict(files)
    patch_root = Path(__file__).resolve().parents[1]/'patches'
    patches, patch_bytes = {}, {}
    for name, allowed in PATCHES.items():
        data = bounded_read(patch_root/name)
        patch_bytes[name] = data
        patches[name] = {'sha256':sha(data),'hunks':apply_patch(files,data,allowed)}
    outputs, mapping = {}, []
    for name, data in sorted(files.items()):
        patched_sha = sha(data)
        if name.endswith('.py'):
            data, changes, imports = relocate(name,data,files)
            target = ROOT+'/'+name
            outputs[target] = data
        else:
            target, changes, imports = ROOT+'/notices/faster-whisper-requirements-patched.txt', [], []
            outputs[target] = data
        mapping.append({'input':name,'inputSha256':sha(before[name]),'patchedSha256':patched_sha,
                        'output':target,'outputSha256':sha(data),'mechanicalImports':changes,'imports':imports})
    outputs[ROOT+'/__init__.py'] = ('"""Private code-only vendor. No resources or eager reexports."""\n__version__ = '+repr(VERSION)+'\nCODE_ONLY = True\n').encode()
    outputs[ROOT+'/notices/kokoro-onnx-LICENSE'] = sources['kokoro-onnx']['kokoro_onnx-0.6.1.dist-info/licenses/LICENSE']
    for kind in PINS:
        outputs[ROOT+'/notices/'+kind+'-LICENSE'] = sources[kind]['LICENSE']
    for name, data in patch_bytes.items(): outputs[ROOT+'/notices/patches/'+name] = data
    source_provenance = dict(PINS)
    source_provenance['kokoro-onnx'] = {'version':'0.6.1','archiveSha256':K_SHA,'url':K_URL}
    for kind, data in sources.items():
        source_provenance[kind] = dict(source_provenance[kind], members={n:{'sha256':sha(b),'bytes':len(b)} for n,b in sorted(data.items())})
    provenance = {'schema':1,'distribution':'voice-practice-speech-vendor','version':VERSION,
                  'code_only':True,'resource_ready':False,'packaged_admission':False,
                  'sources':source_provenance,'patches':patches,'sourceMap':mapping,
                  'builderSha256':sha(Path(__file__).read_bytes()),
                  'boundaries':{'native':'NOT_RUN','resourceCompatibility':'NOT_RUN','redistributionClearance':'NOT_RUN',
                  'externalDependencies':'UNLOCKED_CODE_ONLY: S4 must resolve OS/ABI/hash locks',
                  'developmentDownloadAPI':'faster_whisper.utils.download_model retained; managed local_files_only gate forbids fallback'}}
    outputs[ROOT+'/provenance.json'] = json_bytes(provenance)
    outputs[ROOT+'/notices/MODIFICATIONS.txt'] = b'Private K explicit session/tokenizer; M offline injected English callers; F array-only/local gate. Original licenses are retained verbatim. Attached patches and provenance identify all modifications. Not a complete runtime or legal clearance.\n'
    dist = ROOT+'-'+VERSION+'.dist-info'
    deps = sorted(name.replace('_','-') for name in EXTERNAL)
    outputs[dist+'/METADATA'] = ('Metadata-Version: 2.1\nName: voice-practice-speech-vendor\nVersion: '+VERSION+'\nSummary: Private code-only speech contracts; NOT resource ready\nRequires-Python: >=3.10\n'+''.join('Requires-Dist: '+name+'\n' for name in deps)+'\nNot a runtime release. No model, dictionary, spaCy data or VAD assets.\n').encode()
    outputs[dist+'/WHEEL'] = b'Wheel-Version: 1.0\nGenerator: voice-practice-offline-v1\nRoot-Is-Purelib: true\nTag: py3-none-any\n'
    record = io.StringIO(newline=''); writer=csv.writer(record,lineterminator='\n')
    for name, data in sorted(outputs.items()):
        writer.writerow((name,'sha256='+base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('='),len(data)))
    writer.writerow((dist+'/RECORD','','')); outputs[dist+'/RECORD'] = record.getvalue().encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer,'w',compression=zipfile.ZIP_STORED) as wheel:
        for name,data in sorted(outputs.items()):
            safe_name(name)
            info=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0)); info.create_system=3
            info.external_attr=(stat.S_IFREG|0o644)<<16
            wheel.writestr(info,data)
    output_dir.mkdir(parents=True,exist_ok=False)
    for name,data in outputs.items():
        target=output_dir/'source'/name; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(data)
    wheel_name=ROOT+'-'+VERSION+'-py3-none-any.whl'
    artifact=buffer.getvalue(); (output_dir/wheel_name).write_bytes(artifact)
    (output_dir/'SOURCE-MAP.json').write_bytes(json_bytes(provenance))
    receipt={'wheel':wheel_name,'bytes':len(artifact),'sha256':sha(artifact),'code_only':True,'resource_ready':False}
    (output_dir/'build-result.json').write_bytes(json_bytes(receipt))
    return receipt


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for flag in ('kokoro-source','misaki-source','faster-whisper-source','output-dir'):
        parser.add_argument('--'+flag,required=True,type=Path)
    args=parser.parse_args()
    try:
        result=build(**vars(args))
    except (ValueError,OSError,KeyError,zipfile.BadZipFile,SyntaxError) as error:
        print('speech vendor build rejected: '+str(error),file=sys.stderr)
        return 1
    print(json.dumps(result,sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
