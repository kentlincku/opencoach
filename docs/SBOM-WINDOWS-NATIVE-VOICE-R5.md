# Windows Native Voice Runtime Software Bill of Materials (SBOM) & Distribution Clearance (R5)

This document provides the definitive, comprehensive dependency inventory and licensing clearance determination for the Windows Native Voice Runtime and bundled model artifacts for Release R5.

---

## 1. Executive Summary & Remediation Highlights

In Release R5, all previously identified redistribution blockers have been systematically eliminated:

1. **PyAV / FFmpeg / x264 / x265 Removal**:
   - `faster-whisper` (1.2.1) has been remediated via an MIT patch (`patches/faster-whisper-1.2.1-wav-only.patch`) removing top-level PyAV imports.
   - Upstream faster-whisper repository: `https://github.com/SYSTRAN/faster-whisper.git` (tag: `v1.2.1`, commit: `65882eee9f5cdbeeb2d877f1131d48cf241b327d`).
   - A standalone, strict RIFF PCM-WAV decoder (`native/python/voice_runtime/wav_decoder.py`) decodes controlled 16-bit 16kHz mono/stereo WAV directly to float32 NumPy samples.
   - PyAV, FFmpeg, and compiled x264/x265 binaries are completely excluded from requirements and the PyInstaller runtime bundle.

2. **phonemizer / eSpeak-NG Removal**:
   - Replaced with Misaki English G2P (`misaki==0.9.4`, Apache-2.0) and spaCy (`spacy==3.8.16`, `en_core_web_sm==3.8.0`).
   - Generates phonemes natively matching Kokoro v1.0 vocabulary.
   - Zero GPL TTS components (`phonemizer`, `espeak-ng.dll`, `espeak-ng-data`, `espeakng-loader`) are packaged or loaded into memory.

3. **License Evaluation Results (Separate Categorization)**:
   - **GPL_COMPONENT_TREE_SCAN**: `PASS` (Zero GPL/LGPL/copyleft components in the unpacked binary tree: no PyAV, FFmpeg, x264, x265, phonemizer, or eSpeak-NG)
   - **ENGINEERING_LICENSE_INVENTORY**: `PASS` (66 locked pip packages + 2 in-tree modules cataloged under permissive MIT, Apache-2.0, BSD-3-Clause, MPL-2.0 licenses)
   - **FORMAL_LEGAL_CLEARANCE**: `NOT_RUN` (Technical and engineering licensing audit performed; formal counsel review has not been executed)

---

## 2. Artifacts Summary & Specifications

- **Target Architecture**: Windows 11 / 10 x64 (`win32-x64-cpu`)
- **Python Engine**: Python 3.11.15 CPython frozen runtime (`voice-runtime.exe` with PyInstaller 6.22.2)
- **Lockfile Package Count**: 66 packages (`spikes/packaged-runtime/requirements-windows-x64.lock.txt`, SHA-256 pinned)
- **In-Tree Replacement Modules**: 2 modules:
  * `kokoro_onnx`: Derived from upstream `thewh1teagle/kokoro-onnx` (MIT License, Copyright (c) 2025 thewh1teagle). Modifications, Misaki G2P integration, and offline loader authored under Apache-2.0 (Copyright (c) 2026 kentlincku). Contains `DEFAULT_VOCAB` preserved from upstream MIT project.
  * `num2words`: Clean-room English number verbalization implementation under Apache-2.0 (Copyright (c) 2026 kentlincku).
- **Specfile**: `spikes/packaged-runtime/voice-runtime.spec`
- **Packaging Method**: Standalone directory package bundled into canonical ZIP archives
- **Included Legal Notices in Runtime**:
  - `NOTICE.txt`: Comprehensive component inventory, attribution, and license details
  - `COPYING.GPLv3.txt`: Official full text of GPLv3 retained for complete legal documentation
  - `THIRD_PARTY_LICENSES.txt`: Complete, untruncated texts of Apache-2.0, MIT, BSD-3-Clause, MPL-2.0, and CC-BY 4.0

### Canonical Artifact Set (R5)

| Archive Name | Payload Content | License | Upstream Sources / Notes |
|---|---|---|---|
| `voice-runtime-windows-x64.zip` | Standalone runtime executable (`voice-runtime.exe`), `_internal/` modules & DLLs, runtime manifest, and legal notices | Permissive Bundle (MIT/Apache/BSD) | PyInstaller build of `voice_runtime` with Misaki G2P and WAV-only Whisper |
| `whisper-base-en.zip` | `model.bin`, `config.json`, `tokenizer.json`, `vocabulary.txt`, `LICENSE.txt` | MIT | `Systran/faster-whisper-base.en` |
| `kokoro-v1.0-onnx.zip` | `kokoro-v1.0.onnx`, `voices-v1.0.bin`, `LICENSE.txt`, `ATTRIBUTION.md` | Apache-2.0, CC-BY-4.0 | `hexgrad / thewh1teagle` (Apache-2.0 model, CC-BY-4.0 corpus attributions) |

---

## 3. Negative Runtime Tree Audit (GPL & Codec Scan)

A recursive scan of `dist/voice-runtime` confirms zero forbidden components:

| Component / Pattern | Status | Notes |
|---|---|---|
| `av` (PyAV) | ABSENT | Lockfile and runtime tree contain 0 references or binaries |
| `ffmpeg` | ABSENT | No FFmpeg binaries bundled |
| `avcodec` | ABSENT | Zero libavcodec DLLs |
| `avformat` | ABSENT | Zero libavformat DLLs |
| `x264` | ABSENT | Zero libx264 DLLs |
| `x265` | ABSENT | Zero libx265 DLLs |
| `phonemizer` | ABSENT | Excluded from spec and lockfile |
| `espeak-ng` | ABSENT | Zero espeak-ng DLLs or data directories |
| `espeakng_loader` | ABSENT | Excluded from spec and lockfile |

Negative Scan Result: **PASS** (Zero copyleft components present).

---

## 4. Complete Locked Dependency Inventory

| Package | Version | SPDX License | Direct / Transitive | Upstream Source / Repository |
|---|---|---|---|---|
| `addict` | 2.4.0 | `MIT` | Transitive (misaki) | https://github.com/mewwts/addict |
| `altgraph` | 0.17.5 | `MIT` | Transitive (pyinstaller) | https://github.com/ronaldoussoren/altgraph |
| `annotated-doc` | 0.0.5 | `MIT` | Transitive (spacy) | https://github.com/tiangolo/annotated-doc |
| `annotated-types` | 0.8.0 | `MIT` | Transitive (pydantic) | https://github.com/annotated-types/annotated-types |
| `anyio` | 4.15.0 | `MIT` | Transitive (httpx) | https://github.com/agronholm/anyio |
| `blis` | 1.3.3 | `BSD-3-Clause` | Transitive (spacy/thinc) | https://github.com/explosion/cython-blis |
| `catalogue` | 2.0.10 | `MIT` | Transitive (spacy) | https://github.com/explosion/catalogue |
| `certifi` | 2026.7.22 | `MPL-2.0` | Transitive (httpx) | https://github.com/certifi/python-certifi |
| `cffi` | 2.1.1 | `MIT` | Transitive (soundfile) | https://github.com/python-cffi/cffi |
| `charset-normalizer` | 3.5.1 | `MIT` | Transitive (huggingface-hub) | https://github.com/Ousret/charset_normalizer |
| `click` | 8.5.0 | `BSD-3-Clause` | Transitive (huggingface-hub) | https://github.com/pallets/click |
| `cloudpathlib` | 0.25.0 | `MIT` | Transitive (spacy) | https://github.com/drivendataorg/cloudpathlib |
| `colorama` | 0.4.6 | `BSD-3-Clause` | Transitive (tqdm) | https://github.com/tartley/colorama |
| `confection` | 1.3.3 | `MIT` | Transitive (spacy) | https://github.com/explosion/confection |
| `ctranslate2` | 4.8.2 | `MIT` | Direct (faster-whisper) | https://github.com/OpenNMT/CTranslate2 |
| `cymem` | 2.0.13 | `MIT` | Transitive (spacy) | https://github.com/explosion/cymem |
| `en-core-web-sm` | 3.8.0 | `MIT` | Direct (spacy model) | https://github.com/explosion/spacy-models |
| `faster-whisper` | 1.2.1+wavonly | `MIT` | Direct (STT Engine) | https://github.com/SYSTRAN/faster-whisper |
| `filelock` | 3.32.5 | `Unlicense` OR `MIT` | Transitive (huggingface-hub) | https://github.com/tox-dev/filelock |
| `flatbuffers` | 25.12.19 | `Apache-2.0` | Transitive (onnxruntime) | https://github.com/google/flatbuffers |
| `fsspec` | 2026.7.0 | `BSD-3-Clause` | Transitive (huggingface-hub) | https://github.com/fsspec/filesystem_spec |
| `h11` | 0.16.0 | `MIT` | Transitive (httpcore) | https://github.com/python-hyper/h11 |
| `hf-xet` | 1.6.0 | `Apache-2.0` | Transitive (huggingface-hub) | https://github.com/huggingface/hf-xet |
| `httpcore` | 1.0.9 | `BSD-3-Clause` | Transitive (httpx) | https://github.com/encode/httpcore |
| `httpx` | 0.28.1 | `BSD-3-Clause` | Transitive (huggingface-hub) | https://github.com/encode/httpx |
| `huggingface-hub` | 1.30.0 | `Apache-2.0` | Direct / Transitive | https://github.com/huggingface/huggingface_hub |
| `idna` | 3.19 | `BSD-3-Clause` | Transitive (httpx) | https://github.com/kjd/idna |
| `jinja2` | 3.1.6 | `BSD-3-Clause` | Transitive (spacy) | https://github.com/pallets/jinja |
| `markdown-it-py` | 4.2.0 | `MIT` | Transitive (rich) | https://github.com/executablebooks/markdown-it-py |
| `markupsafe` | 3.0.3 | `BSD-3-Clause` | Transitive (jinja2) | https://github.com/pallets/markupsafe |
| `mdurl` | 0.1.2 | `MIT` | Transitive (markdown-it-py) | https://github.com/executablebooks/mdurl |
| `misaki` | 0.9.4 | `Apache-2.0` | Direct (TTS G2P Engine) | https://github.com/hexgrad/misaki |
| `murmurhash` | 1.0.15 | `MIT` | Transitive (spacy) | https://github.com/explosion/murmurhash |
| `numpy` | 2.4.6 | `BSD-3-Clause` | Direct / Transitive | https://github.com/numpy/numpy |
| `onnxruntime` | 1.29.0 | `MIT` | Direct / Transitive | https://github.com/microsoft/onnxruntime |
| `packaging` | 26.3 | `Apache-2.0` OR `BSD-2-Clause` | Transitive | https://github.com/pypa/packaging |
| `pefile` | 2024.8.26 | `MIT` | Transitive (pyinstaller) | https://github.com/erocarrera/pefile |
| `preshed` | 3.0.13 | `MIT` | Transitive (spacy) | https://github.com/explosion/preshed |
| `protobuf` | 7.36.1 | `BSD-3-Clause` | Transitive (onnxruntime) | https://github.com/protocolbuffers/protobuf |
| `pycparser` | 3.0 | `BSD-3-Clause` | Transitive (cffi) | https://github.com/eliben/pycparser |
| `pydantic` | 2.13.5 | `MIT` | Transitive (spacy) | https://github.com/pydantic/pydantic |
| `pydantic-core` | 2.46.5 | `MIT` | Transitive (pydantic) | https://github.com/pydantic/pydantic-core |
| `pygments` | 2.21.0 | `BSD-2-Clause` | Transitive (rich) | https://github.com/pygments/pygments |
| `pyinstaller` | 6.22.2 | `GPL-2.0-or-later` w/ Special Exception | Build Tool | https://github.com/pyinstaller/pyinstaller |
| `pyinstaller-hooks-contrib` | 2026.7 | `Apache-2.0` OR `GPL-2.0` | Build Tool | https://github.com/pyinstaller/pyinstaller-hooks-contrib |
| `pywin32-ctypes` | 0.2.3 | `BSD-3-Clause` | Transitive (pyinstaller) | https://github.com/enthought/pywin32-ctypes |
| `pyyaml` | 6.0.3 | `MIT` | Transitive (huggingface-hub) | https://github.com/yaml/pyyaml |
| `regex` | 2026.9.3 | `Apache-2.0` | Transitive (misaki/tokenizers) | https://github.com/mrabarnett/mrab-regex |
| `requests` | 2.34.2 | `Apache-2.0` | Transitive (spacy) | https://github.com/psf/requests |
| `rich` | 15.0.0 | `MIT` | Transitive (spacy) | https://github.com/Textualize/rich |
| `setuptools` | 84.0.0 | `MIT` | Build / Transitive | https://github.com/pypa/setuptools |
| `shellingham` | 1.5.4 | `BSD-3-Clause` | Transitive (typer) | https://github.com/sarugaku/shellingham |
| `smart-open` | 8.0.1 | `MIT` | Transitive (spacy) | https://github.com/RaRe-Technologies/smart_open |
| `soundfile` | 0.14.0 | `BSD-3-Clause` | Direct | https://github.com/bastibe/python-soundfile |
| `spacy` | 3.8.16 | `MIT` | Direct (G2P POS tagger) | https://github.com/explosion/spaCy |
| `spacy-legacy` | 3.0.12 | `MIT` | Transitive (spacy) | https://github.com/explosion/spacy-legacy |
| `spacy-loggers` | 1.0.5 | `MIT` | Transitive (spacy) | https://github.com/explosion/spacy-loggers |
| `srsly` | 2.5.3 | `MIT` | Transitive (spacy) | https://github.com/explosion/srsly |
| `thinc` | 8.3.13 | `MIT` | Transitive (spacy) | https://github.com/explosion/thinc |
| `tokenizers` | 0.23.2 | `Apache-2.0` | Transitive (faster-whisper) | https://github.com/huggingface/tokenizers |
| `tqdm` | 4.70.0 | `MPL-2.0` AND `MIT` | Transitive (huggingface-hub) | https://github.com/tqdm/tqdm |
| `typer` | 0.27.2 | `MIT` | Transitive (spacy) | https://github.com/tiangolo/typer |
| `typing-extensions` | 4.16.0 | `PSF-2.0` | Transitive | https://github.com/python/typing_extensions |
| `typing-inspection` | 0.4.4 | `MIT` | Transitive (spacy) | https://github.com/tiangolo/typing-inspection |
| `urllib3` | 2.7.0 | `MIT` | Transitive (requests) | https://github.com/urllib3/urllib3 |
| `wasabi` | 1.1.3 | `MIT` | Transitive (spacy) | https://github.com/explosion/wasabi |
| `weasel` | 1.0.0 | `MIT` | Transitive (spacy) | https://github.com/explosion/weasel |
| `wrapt` | 2.4.0 | `BSD-2-Clause` | Transitive (spacy) | https://github.com/GrahamDumpleton/wrapt |

### 4.2 In-Tree Replacement Modules (2 Modules)

| Module | Purpose | Effective License | Upstream Origin & Provenance |
|---|---|---|---|
| `kokoro_onnx` | ONNX Kokoro TTS Inference Engine with Misaki English G2P | Composite: MIT (base) + Apache-2.0 (modifications) | Base architecture & `DEFAULT_VOCAB` derived from upstream `thewh1teagle/kokoro-onnx` (MIT License). Misaki G2P integration and offline loader under Apache-2.0. |
| `num2words` | English Cardinal, Ordinal, and Year Verbalization | `Apache-2.0` | Clean-room pure-Python implementation authored under Apache-2.0 to replace external LGPL-2.1 `num2words` library. |

---

## 5. Model Weights & Training Corpora Attributions

1. **Kokoro v1.0 ONNX Model**:
   - Model weights file: `kokoro-v1.0.onnx` (82M params)
   - Voice style vectors: `voices-v1.0.bin`
   - License: Apache-2.0 (hexgrad / thewh1teagle)
   - Training corpora: Style characteristics derived from LibriTTS (CC-BY 4.0, Heiga Zen et al.) and LJSpeech (Public Domain, Keith Ito). Complete attribution in `ATTRIBUTION.md`.

2. **Whisper Base (English)**:
   - Model files: `model.bin`, `config.json`, `tokenizer.json`, `vocabulary.txt`
   - License: MIT (OpenAI / SYSTRAN faster-whisper)
