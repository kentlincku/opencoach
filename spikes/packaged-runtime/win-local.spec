# Local (single-machine) Windows x64 build. Inputs are listed in a plan file written
# and re-verified by scripts/win-build-local-runtime.py; no admission ceremony.
import json, os, sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

cfg = json.loads(Path(os.environ['WIN_BUILD_PLAN']).read_text(encoding='utf-8'))
root = Path(SPECPATH).parents[1]
hidden = ['voice_runtime.backends.faster_whisper', 'voice_runtime.backends.kokoro_onnx',
          'voice_runtime.english_g2p', 'voice_runtime.english_numbers', 'voice_runtime.onnx_engine',
          'voice_runtime.accelerator', 'onnxruntime', 'ctranslate2', 'tokenizers',
          'voice_practice_speech_vendor.faster_whisper', 'voice_practice_speech_vendor.kokoro_onnx',
          'voice_practice_speech_vendor.kokoro_onnx.session', 'voice_practice_speech_vendor.misaki.en',
          'spacy.lang.en', 'spacy.pipeline', 'spacy_legacy', 'spacy_loggers', 'inflect', 'addict', 'regex']
excludes = ['voice_runtime.backends.fake', 'voice_runtime.backends.kokoro_python', 'voice_runtime.backends.mlx_whisper',
            'mlx', 'mlx_whisper', 'kokoro', 'kokoro_onnx', 'misaki', 'faster_whisper', 'torch', 'torchaudio',
            'phonemizer', 'espeakng_loader', 'soundfile', 'av', 'numba', 'llvmlite', 'tkinter',
            'spacy.tests', 'numpy.tests', 'PyInstaller', '_pyinstaller_hooks_contrib']
a = Analysis([str(Path(SPECPATH) / 'win-entry.py')],
             pathex=[cfg['overlay'], str(root / 'native/python')],
             hiddenimports=hidden, excludes=excludes,
             datas=[tuple(x) for x in cfg['datas']] + collect_data_files('spacy', excludes=['**/tests/**']),
             binaries=[tuple(x) for x in cfg['binaries']],
             module_collection_mode={'inflect': 'pyz+py'})
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='voice-runtime', console=True,
          contents_directory='_internal', upx=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='bin')
