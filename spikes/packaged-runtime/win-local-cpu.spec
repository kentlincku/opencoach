# Local Windows x64 CPU-only build for runtime-only Apps (W1). Inputs are listed in a plan
# file written by scripts/win-build-local-runtime-cpu.py. No CUDA: no nvidia binaries are
# added, and any CUDA/cuDNN/TensorRT DLL found by dependency analysis is dropped here and
# recorded; the builder's receipt gate re-checks the final tree.
import json, os, sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files

cfg = json.loads(Path(os.environ['WIN_BUILD_PLAN']).read_text(encoding='utf-8'))
root = Path(SPECPATH).parents[1]
sys.path.insert(0, str(root / 'scripts'))
from win_cpu_runtime_policy import filter_binaries

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
             binaries=[],
             module_collection_mode={'inflect': 'pyz+py'})
kept, dropped = filter_binaries(list(a.binaries))
Path(cfg['dropLog']).write_text(json.dumps(dropped) + '\n', encoding='utf-8')
a.binaries = kept
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='voice-runtime', console=True,
          contents_directory='_internal', upx=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='bin')
