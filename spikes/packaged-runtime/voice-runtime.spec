# Run from the repository root with PyInstaller installed in a Python 3.11 native-runner environment.
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

root = Path(SPECPATH).parents[1]
datas = (
    collect_data_files('language_tags') +
    collect_data_files('misaki') +
    collect_data_files('mlx') +
    collect_data_files('mlx_whisper') +
    collect_data_files('spacy') +
    collect_data_files('en_core_web_sm') +
    collect_data_files('faster_whisper')
)
hiddenimports = (
    collect_submodules('mlx') +
    collect_submodules('mlx_whisper') +
    [
        'kokoro_onnx',
        'voice_runtime.backends.fake',
        'voice_runtime.backends.kokoro_python',
        'voice_runtime.backends.kokoro_onnx',
        'voice_runtime.backends.mlx_whisper',
        'voice_runtime.backends.faster_whisper',
        'en_core_web_sm',
        'misaki',
        'num2words',
        'spacy',
    ]
)
excludes = [
    'av',
    'phonemizer',
    'espeakng_loader',
    'espeak-ng',
    'espeakng',
]
a = Analysis(
    [str(root / 'spikes/packaged-runtime/entrypoint.py')],
    pathex=[str(root / 'native/python')],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='voice-runtime', console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='voice-runtime')
