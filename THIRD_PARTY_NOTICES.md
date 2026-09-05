# Third-party notices

OpenCoach's original source is Apache-2.0, except where a file contains a different notice. Dependencies and optional assets remain under their upstream terms.

This document is an engineering inventory, not legal advice. Exact dependency versions are pinned in `package-lock.json` and the platform runtime lockfiles.

## Source and runtime components

| Component | License | Scope / provenance |
|---|---|---|
| Electron | MIT | Desktop application runtime; obtained during dependency installation |
| yauzl / yazl | MIT | ZIP validation and generation |
| `@huggingface/transformers` | Apache-2.0 | Browser model runtime development dependency |
| Kokoro.js | Apache-2.0 | Optional browser TTS path |
| faster-whisper 1.2.1 | MIT | Pinned upstream source at `65882eee9f5cdbeeb2d877f1131d48cf241b327d`; WAV-only changes are a committed patch |
| CTranslate2 | MIT | Windows native STT runtime dependency |
| ONNX Runtime | MIT | Native Kokoro inference dependency |
| kokoro-onnx-derived adapter | MIT upstream portions + Apache-2.0 modifications | Upstream notice is preserved in `native/python/kokoro_onnx/__init__.py` |
| Misaki | Apache-2.0 | English grapheme-to-phoneme implementation |
| spaCy / en_core_web_sm | MIT | Offline language processing for the Windows runtime path |
| NumPy | BSD-3-Clause | Native numeric runtime |
| SoundFile | BSD-3-Clause | WAV I/O; distributors must verify the packaged native-library inventory |
| PyInstaller | GPL-2.0-or-later with bootloader exception | Build tool; see upstream exception terms |
| Apple FoundationModels | Apple platform framework | Referenced through system APIs; not redistributed by this repository |

Full license texts collected for the Windows engineering runtime are under `legal/`. Package metadata remains the authority for exact transitive dependency versions.

## Models and voice assets

The repository does **not** include model weights or voice embeddings.

- OpenAI Whisper model artifacts are distributed under their upstream model terms (commonly MIT for official OpenAI releases). Verify the exact artifact before publication.
- Kokoro model and voice artifacts must carry the exact upstream license and attribution for the selected release. Dataset-derived attribution, including applicable CC-BY obligations, must accompany any redistributed voice artifact.
- Browser-generated model bundles and caches are excluded from Git.

The Apache-2.0 project license does not relicense any downloaded model or dataset.

## Platform-specific copyleft boundary

The current Windows WAV-only engineering path excludes PyAV/FFmpeg/x264/x265 and phonemizer/eSpeak-NG from its packaged runtime. Its engineering inventory is documented in `docs/SBOM-WINDOWS-NATIVE-VOICE-R5.md`.

Some macOS research/build inputs still reference phonemizer/eSpeak-related components under copyleft licenses. No public macOS native runtime binary is authorized by this source repository. Anyone publishing such a bundle must independently satisfy the corresponding licenses and source obligations.

## Release requirement

Before publishing any binary or model asset, produce an artifact-specific inventory containing:

- exact source commit and build command
- filename, byte size, SHA-256, and payload tree digest
- every included third-party component and license
- model and dataset provenance
- signing/notarization status
- corresponding-source or notice obligations where applicable
