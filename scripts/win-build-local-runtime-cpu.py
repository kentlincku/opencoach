#!/usr/bin/env python3
"""Local Windows x64 CPU-only runtime build for runtime-only (W1) Apps; NOT a release admission.

Differences from scripts/win-build-local-runtime.py (legacy full-bundle, CUDA-capable):
  - the build venv must hold CPU onnxruntime==1.30.0, ctranslate2==4.8.2, faster-whisper==1.2.1
    and NO onnxruntime-gpu / nvidia-* / tensorrt distributions (check_distributions);
  - no nvidia DLLs are collected; ctranslate2's wheel-bundled cudnn64_9.dll is dropped from the
    freeze TOC (CPU int8 inference does not load it; verified on the Windows host);
  - PyInstaller runs with PATH = %SystemRoot%\\System32;%SystemRoot% so a CUDA toolkit on the
    developer PATH cannot leak cublas64_13.dll/cublasLt64_13.dll into the tree;
  - the receipt gate refuses any cublas*/cudnn*/nvrtc*/onnxruntime_providers_cuda|tensorrt* file;
  - Kokoro: only the fp16 profile (embedded vocab); no model bytes are frozen into the runtime.
Inputs: <resources>/acquisition.json (misaki/spaCy/kokoro fp16 for vocab) + silero_vad_v6.onnx.
Output: <out>/build-cpu-NNN/{dist/runtime/bin, receipt.json}.
Usage: <cpu-venv>\\Scripts\\python.exe scripts/win-build-local-runtime-cpu.py <resources> <out>
"""
import hashlib, json, os, re, shutil, subprocess, sys, zipfile
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from win_cpu_runtime_policy import check_distributions, sanitized_build_path, receipt_gate  # noqa: E402

SILERO_SHA = '4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2'
WANT = {'kokoro/kokoro-v1.0.fp16.onnx', 'misaki/en/us_gold.json', 'misaki/en/us_silver.json',
        'spacy/en_core_web_sm-3.8.0-py3-none-any.whl'}


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()


def fail(m): sys.exit('WIN_CPU_BUILD_REFUSED: ' + m)


def main():
    if sys.platform != 'win32': fail('Windows only')
    if len(sys.argv) != 3: fail('usage: <resources> <out>')
    res, out_parent = (Path(a).resolve() for a in sys.argv[1:3])
    if subprocess.run(['git', 'status', '--porcelain'], cwd=ROOT, capture_output=True, text=True).stdout.strip():
        fail('worktree not clean')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    installed = {d.metadata['Name']: d.version for d in metadata.distributions()}
    try: check_distributions(installed)
    except ValueError as error: fail(str(error))
    acq = json.loads((res / 'acquisition.json').read_text(encoding='utf-8'))

    def verify_inputs():
        seen = set()
        for f in acq['files']:
            if f['path'] not in WANT: continue
            p = res / f['path']
            if p.is_symlink() or sha(p) != f['sha256']: fail('resource drift ' + f['path'])
            seen.add(f['path'])
        if seen != WANT: fail('resource missing ' + ','.join(sorted(WANT - seen)))
        if sha(res / 'silero_vad_v6.onnx') != SILERO_SHA: fail('silero drift')

    verify_inputs()
    vendor = metadata.distribution('voice-practice-speech-vendor')
    if 'CODE_ONLY = True' not in Path(vendor.locate_file('voice_practice_speech_vendor/__init__.py')).read_text(encoding='utf-8'):
        fail('unexpected vendor build')

    n = 1 + max([int(m.group(1)) for d in out_parent.glob('build-cpu-*') if (m := re.fullmatch(r'build-cpu-(\d{3})', d.name))] or [0])
    out = out_parent / f'build-cpu-{n:03d}'
    out.mkdir(parents=True)
    stage = out / 'stage'; stage.mkdir()
    vres = stage / 'vendor-resources'
    (vres / 'misaki/en').mkdir(parents=True)
    for f in ('us_gold.json', 'us_silver.json'): shutil.copy2(res / 'misaki/en' / f, vres / 'misaki/en' / f)
    with zipfile.ZipFile(res / 'spacy/en_core_web_sm-3.8.0-py3-none-any.whl') as z: z.extractall(stage / 'spacy-whl')
    shutil.copytree(stage / 'spacy-whl/en_core_web_sm/en_core_web_sm-3.8.0', vres / 'spacy/en_core_web_sm-3.8.0')

    import onnxruntime as rt
    if {'CUDAExecutionProvider', 'TensorrtExecutionProvider'} & set(rt.get_available_providers()):
        fail('onnxruntime exposes CUDA provider')
    so = rt.SessionOptions(); so.log_severity_level = 3
    fp16 = res / 'kokoro/kokoro-v1.0.fp16.onnx'
    vocab = json.loads(rt.InferenceSession(str(fp16), so, providers=['CPUExecutionProvider']).get_modelmeta().custom_metadata_map['kokoro_config'])['vocab']
    digest = hashlib.sha256(json.dumps(sorted(vocab.items()), ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    (vres / 'kokoro').mkdir(parents=True)
    profiles = [{'profileId': 'kokoro-v1_0-fp16', 'modelBytes': fp16.stat().st_size, 'modelSha256': sha(fp16),
                 'vocabSource': 'embedded', 'vocabCanonicalSha256': digest}]
    (vres / 'kokoro/compatibility.json').write_text(json.dumps({'schemaVersion': 1, 'profiles': profiles}, indent=1) + '\n', encoding='utf-8')

    datas = [(str(p), str(Path('voice_practice_speech_vendor/resources') / p.parent.relative_to(vres)))
             for p in sorted(vres.rglob('*')) if p.is_file()]
    datas.append((str(res / 'silero_vad_v6.onnx'), 'voice_practice_speech_vendor/faster_whisper/assets'))
    for dist in metadata.distributions():
        for f in dist.files or ():
            m = str(f).replace('\\', '/')
            if m.endswith('.pth') or m.startswith('..'): continue
            notice = ('.dist-info/' in m and (m.endswith(('METADATA', 'WHEEL')) or '/licenses/' in m)) \
                or Path(m).name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE', 'THIRDPARTYNOTICES'))
            vend = m.startswith('voice_practice_speech_vendor/') and not m.endswith('.py') and '/resources/' not in m
            if notice or vend: datas.append((str(dist.locate_file(f)), str(Path(m).parent)))

    plan = out / 'plan.json'
    plan.write_text(json.dumps({'overlay': str(stage), 'datas': datas, 'dropLog': str(out / 'dropped-binaries.json')}, indent=1), encoding='utf-8')
    system_root = os.environ.get('SystemRoot') or os.environ.get('SYSTEMROOT') or 'C:\\Windows'
    env = {k: v for k, v in os.environ.items() if k.upper() not in ('PYTHONPATH', 'PYTHONHOME', 'PATH', 'CUDA_PATH')
           and not k.upper().startswith('CUDA_PATH_')}
    env.update(PATH=sanitized_build_path(system_root), WIN_BUILD_PLAN=str(plan), PYTHONDONTWRITEBYTECODE='1',
               HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYINSTALLER_CONFIG_DIR=str(out / 'pyinstaller-cache'))
    subprocess.run([sys.executable, '-I', '-B', '-m', 'PyInstaller', '--noconfirm', '--log-level', 'WARN',
                    '--distpath', str(out / 'dist/runtime'), '--workpath', str(out / 'work'),
                    str(ROOT / 'spikes/packaged-runtime/win-local-cpu.spec')], cwd=ROOT, env=env, check=True)
    verify_inputs()

    rt_root = out / 'dist/runtime'
    internal = rt_root / 'bin/_internal'
    for p in sorted(internal.glob('*+*.dist-info')): p.rename(p.with_name(p.name.replace('+', '_')))
    lorem = internal / 'setuptools/_vendor/jaraco/text/Lorem ipsum.txt'
    if lorem.exists(): lorem.unlink()
    for d in sorted((p for p in rt_root.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        if not any(d.iterdir()): d.rmdir()
    rel = [p.relative_to(rt_root).as_posix() for p in sorted(rt_root.rglob('*')) if p.is_file()]
    try: gate = receipt_gate(rel)
    except ValueError as error: fail(str(error))
    models = [r for r in rel if r.lower().endswith(('.safetensors', '.gguf')) or re.fullmatch(r'(?i).*/(model\.bin|voices(-v[0-9.]+)?\.bin|kokoro[^/]*\.onnx)', r)]
    if models: fail('speech model bytes in runtime: ' + ','.join(models))
    bad = [p.relative_to(rt_root).as_posix() for p in rt_root.rglob('*') if not re.fullmatch(r'[A-Za-z0-9._-]+', p.name)]
    links = [p.relative_to(rt_root).as_posix() for p in rt_root.rglob('*') if p.is_symlink()]
    files = {p.relative_to(rt_root).as_posix(): sha(p) for p in sorted(rt_root.rglob('*')) if p.is_file() and not p.is_symlink()}
    dropped = json.loads((out / 'dropped-binaries.json').read_text(encoding='utf-8'))
    receipt = {'class': 'WIN_CPU_LOCAL_SINGLE_MACHINE_NOT_RELEASE', 'commit': commit, 'flavor': 'cpu',
               'acquisition': sha(res / 'acquisition.json'), 'sileroVadSha256': SILERO_SHA,
               'distributions': {k: installed[k] for k in sorted(installed)}, 'buildPath': env['PATH'],
               'droppedBinaries': dropped, 'cudaPayload': gate['cudaPayload'], 'forbiddenPatterns': gate['forbiddenPatterns'],
               'nonPortableNames': bad, 'symlinks': links, 'fileCount': len(files),
               'treeSha256': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()}
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=1) + '\n', encoding='utf-8')
    shutil.rmtree(stage); shutil.rmtree(out / 'work')
    print(json.dumps({k: receipt[k] for k in ('commit', 'fileCount', 'treeSha256', 'cudaPayload')}), 'dropped', dropped)
    print('OUTPUT', out)


if __name__ == '__main__':
    main()
