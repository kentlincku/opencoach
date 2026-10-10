#!/usr/bin/env python3
"""Local Windows x64 runtime build (this machine only; NOT a release admission).

Inputs (verified before and after the build):
  - a dedicated venv (this interpreter) holding faster-whisper/ctranslate2, onnxruntime-gpu,
    the nvidia cublas/cudnn/nvrtc wheels and the private code-only speech vendor wheel;
  - <resources>/acquisition.json: hash-pinned Kokoro/misaki/spaCy files (same set as the
    macOS R56 acquisition) plus silero_vad_v6.onnx from faster-whisper 65882ee;
  - git HEAD must be clean; the commit is recorded in the receipt.
Output: <out>/build-local-NNN/ with dist/runtime/bin and receipt.json.
Usage: <venv>\\Scripts\\python.exe scripts/win-build-local-runtime.py <resources> <out>
"""
import hashlib, json, os, re, shutil, subprocess, sys, zipfile
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RES, OUT_PARENT = (Path(a).resolve() for a in sys.argv[1:3])
SILERO_SHA = '4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2'
VENDOR_CODE_SHA = '472a6fdfd3c3820add475fce3f547623098b0978f8e60bb8608ab16b3ec47e80'
NVIDIA_LIBS = ('cublas', 'cudnn', 'cuda_nvrtc')
# Windows bundles the fp32 Kokoro model: the fp16 export overflows to NaN on the CUDA
# provider with real voice styles (CPU is fine). Pinned to kokoro-onnx model-files-v1.0.
KOKORO_FP32 = ('kokoro/kokoro-v1.0.onnx', 325532387, '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5')


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()


def fail(m): sys.exit('WIN_BUILD_REFUSED: ' + m)


if sys.platform != 'win32': fail('Windows only')
if subprocess.run(['git', 'status', '--porcelain'], cwd=ROOT, capture_output=True, text=True).stdout.strip():
    fail('worktree not clean')
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
acq = json.loads((RES / 'acquisition.json').read_text(encoding='utf-8'))
WANT = {'kokoro/kokoro-v1.0.fp16.onnx', 'kokoro/voices-v1.0.bin', 'misaki/en/us_gold.json', 'misaki/en/us_silver.json',
        'spacy/en_core_web_sm-3.8.0-py3-none-any.whl'}


def verify_inputs():
    seen = set()
    for f in acq['files']:
        if f['path'] not in WANT: continue
        p = RES / f['path']
        if p.is_symlink() or sha(p) != f['sha256']: fail('resource drift ' + f['path'])
        seen.add(f['path'])
    if seen != WANT: fail('resource missing ' + ','.join(sorted(WANT - seen)))
    if sha(RES / 'silero_vad_v6.onnx') != SILERO_SHA: fail('silero drift')
    fp32 = RES / KOKORO_FP32[0]
    if fp32.is_symlink() or fp32.stat().st_size != KOKORO_FP32[1] or sha(fp32) != KOKORO_FP32[2]: fail('kokoro fp32 drift')


verify_inputs()
vendor = metadata.distribution('voice-practice-speech-vendor')
vendor_init = Path(vendor.locate_file('voice_practice_speech_vendor/__init__.py'))
if 'CODE_ONLY = True' not in vendor_init.read_text(encoding='utf-8'): fail('unexpected vendor build')

n = 1 + max([int(m.group(1)) for d in OUT_PARENT.glob('build-local-*') if (m := re.fullmatch(r'build-local-(\d{3})', d.name))] or [0])
out = OUT_PARENT / f'build-local-{n:03d}'
out.mkdir(parents=True)
stage = out / 'stage'; stage.mkdir()

res = stage / 'vendor-resources'
(res / 'misaki/en').mkdir(parents=True)
for f in ('us_gold.json', 'us_silver.json'): shutil.copy2(RES / 'misaki/en' / f, res / 'misaki/en' / f)
with zipfile.ZipFile(RES / 'spacy/en_core_web_sm-3.8.0-py3-none-any.whl') as z:
    z.extractall(stage / 'spacy-whl')
shutil.copytree(stage / 'spacy-whl/en_core_web_sm/en_core_web_sm-3.8.0', res / 'spacy/en_core_web_sm-3.8.0')

import onnxruntime as rt
so = rt.SessionOptions(); so.log_severity_level = 3
fp16 = RES / 'kokoro/kokoro-v1.0.fp16.onnx'
vocab = json.loads(rt.InferenceSession(str(fp16), so, providers=['CPUExecutionProvider']).get_modelmeta().custom_metadata_map['kokoro_config'])['vocab']
digest = hashlib.sha256(json.dumps(sorted(vocab.items()), ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
(res / 'kokoro/vocabularies').mkdir(parents=True)
# The fp32 export carries no metadata; it uses the same Kokoro v1.0 vocab, supplied as a
# hash-bound runtime profile (taken from the fp16 model's embedded kokoro_config).
vocab_file = res / 'kokoro/vocabularies/kokoro-v1_0-fp32.json'
vocab_file.write_bytes((json.dumps(vocab, ensure_ascii=False, sort_keys=True) + '\n').encode('utf-8'))
fp32 = RES / KOKORO_FP32[0]
profiles = [{'profileId': 'kokoro-v1_0-fp16', 'modelBytes': fp16.stat().st_size, 'modelSha256': sha(fp16), 'vocabSource': 'embedded',
             'vocabCanonicalSha256': digest},
            {'profileId': 'kokoro-v1_0-fp32', 'modelBytes': fp32.stat().st_size, 'modelSha256': sha(fp32), 'vocabSource': 'runtime-profile',
             'vocabCanonicalSha256': digest, 'relativePath': 'resources/kokoro/vocabularies/kokoro-v1_0-fp32.json',
             'vocabBytes': vocab_file.stat().st_size, 'vocabFileSha256': sha(vocab_file)}]
(res / 'kokoro/compatibility.json').write_text(json.dumps({'schemaVersion': 1, 'profiles': profiles}, indent=1) + '\n', encoding='utf-8')

datas = []
for p in sorted(res.rglob('*')):
    if p.is_file(): datas.append((str(p), str(Path('voice_practice_speech_vendor/resources') / p.parent.relative_to(res))))
datas.append((str(RES / 'silero_vad_v6.onnx'), 'voice_practice_speech_vendor/faster_whisper/assets'))
for dist in metadata.distributions():
    for f in dist.files or ():
        m = str(f).replace('\\', '/')
        if m.endswith('.pth') or m.startswith('..'): continue
        notice = ('.dist-info/' in m and (m.endswith(('METADATA', 'WHEEL')) or '/licenses/' in m)) \
            or Path(m).name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE', 'THIRDPARTYNOTICES'))
        vend = m.startswith('voice_practice_speech_vendor/') and not m.endswith('.py') and '/resources/' not in m
        if notice or vend: datas.append((str(dist.locate_file(f)), str(Path(m).parent)))

# CUDA: the pip nvidia wheels' DLLs keep their nvidia/<lib>/bin layout under _internal,
# which is the only directory the frozen accelerator probe trusts.
binaries, nvidia = [], {}
site = Path(metadata.distribution('onnxruntime-gpu').locate_file(''))
for lib in NVIDIA_LIBS:
    for p in sorted((site / 'nvidia' / lib / 'bin').glob('*.dll')):
        binaries.append((str(p), f'nvidia/{lib}/bin')); nvidia[f'{lib}/{p.name}'] = sha(p)
if not nvidia: fail('nvidia wheels missing')

plan = out / 'plan.json'
plan.write_text(json.dumps({'overlay': str(stage), 'datas': datas, 'binaries': binaries}, indent=1), encoding='utf-8')
env = {k: v for k, v in os.environ.items() if k not in ('PYTHONPATH', 'PYTHONHOME')}
env.update(WIN_BUILD_PLAN=str(plan), PYTHONDONTWRITEBYTECODE='1', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
           PYINSTALLER_CONFIG_DIR=str(out / 'pyinstaller-cache'))
subprocess.run([sys.executable, '-I', '-B', '-m', 'PyInstaller', '--noconfirm', '--log-level', 'WARN',
                '--distpath', str(out / 'dist/runtime'), '--workpath', str(out / 'work'),
                str(ROOT / 'spikes/packaged-runtime/win-local.spec')], cwd=ROOT, env=env, check=True)
verify_inputs()

rt_root = out / 'dist/runtime'
# Normalize for the App's integrity checker (portable names only, no empty dirs).
internal = rt_root / 'bin/_internal'
for p in sorted(internal.glob('*+*.dist-info')):
    p.rename(p.with_name(p.name.replace('+', '_')))
lorem = internal / 'setuptools/_vendor/jaraco/text/Lorem ipsum.txt'
if lorem.exists(): lorem.unlink()
for d in sorted((p for p in rt_root.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
    if not any(d.iterdir()): d.rmdir()
bad = [p.relative_to(rt_root).as_posix() for p in rt_root.rglob('*') if not re.fullmatch(r'[A-Za-z0-9._-]+', p.name)]
links = [p.relative_to(rt_root).as_posix() for p in rt_root.rglob('*') if p.is_symlink()]
files = {p.relative_to(rt_root).as_posix(): sha(p) for p in sorted(rt_root.rglob('*')) if p.is_file() and not p.is_symlink()}
receipt = {'class': 'WIN_LOCAL_SINGLE_MACHINE_NOT_RELEASE', 'commit': commit, 'acquisition': sha(RES / 'acquisition.json'),
           'sileroVadSha256': SILERO_SHA, 'kokoroFp32': KOKORO_FP32[2], 'vendorCodeWheelSha256': VENDOR_CODE_SHA, 'nvidia': nvidia,
           'nonPortableNames': bad, 'symlinks': links, 'fileCount': len(files),
           'treeSha256': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()}
(out / 'receipt.json').write_text(json.dumps(receipt, indent=1) + '\n', encoding='utf-8')
shutil.rmtree(stage); shutil.rmtree(out / 'work')
print(json.dumps({k: receipt[k] for k in ('commit', 'fileCount', 'treeSha256')}), 'nonPortable', len(bad), 'symlinks', len(links))
print('OUTPUT', out)
