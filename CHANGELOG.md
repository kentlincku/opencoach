# Changelog

All notable public changes to OpenCoach are documented here.

## [Unreleased]

## [0.3.0-beta.1] - 2026-10-09

macOS (Apple Silicon) release; Windows stays on v0.2.0-beta.1 and iOS is source-only.

### Added

- Speech-to-text model choice: Whisper tiny, base, small, or large-v3-turbo, with a recommendation based on the device. Models are downloaded in Settings from pinned upstream revisions and verified by SHA-256 before use; once installed they work offline.
- Editable coach profiles: each of the eight coaches has its own name, description, speaking style, voice, rate, and pitch, with restore-to-default. On iOS each coach defaults to a different system voice that matches its description.
- iOS: shadowing uses on-device Apple Speech; an "add voice" button explains how to download better system voices and opens Settings.
- Reproducible macOS build: `scripts/ci-pack-macos.sh` builds the voice runtime from pinned public sources (`spikes/packaged-runtime/r56-acquisition.lock.json`), packs the App without model weights, and seals it ad-hoc so Gatekeeper offers **Open Anyway**.

### Changed

- macOS App is smaller (about 186 MB DMG): Kokoro and Whisper weights are no longer bundled; only English and Traditional Chinese Electron locales are shipped.
- iOS App bundle no longer includes browser Whisper/Kokoro payloads (about 44 MB → 1.6 MB).
- Model settings are grouped cards; the global voice selector moved into each coach profile.

### Fixed

- Text-to-speech reads LLM replies that contain slashes, ranges, ratings, Markdown symbols, or stray quotes instead of failing the sentence.
- iOS: confirm/alert dialogs (such as restore-to-default) now work.

### Removed

- Android app and its web adapter. It may return in a later release.

## [0.2.0-beta.1]

### Added

- New public source repository with a clean, privacy-preserving Git history.
- Apache-2.0 project license, security policy, contribution guide, support policy, and third-party notices.
- Shared local-first browser, Electron, iOS, and Android source tree (Android removed in 0.3.0-beta.1).
- Typed desktop and mobile voice/runtime contracts.
- Windows WAV-only faster-whisper source preparation from a pinned upstream commit and reviewable patch.
- Automated source, security, documentation, and cross-platform contract tests.

### Fixed

- Desktop LLM settings accept any user-entered OpenAI-compatible `http`/`https` endpoint (any host/port, e.g. llama.cpp on `:8080` or a LAN server) instead of a fixed list; previously "從端點取得模型" failed for unlisted endpoints. An optional API key for a custom endpoint is kept in the OS keystore. The broker still calls only `/models` and `/chat/completions`, without redirects or URL credentials, and with a response-size cap.
- Text-to-speech no longer rejects LLM replies containing accented Latin letters (`café`), typographic quotes, Markdown lists/line breaks, or free-standing dashes; these are folded to ASCII or spoken as pauses.

- Desktop chat: provider and subscription IPC payloads carry only `{role, content}`, so conversation history with non-cloneable fields no longer fails with `DataCloneError`.
- Text-to-speech no longer reads emoji names aloud (all `Extended_Pictographic`, skin tones, ZWJ sequences, keycaps and flags are stripped).
- Voice conversation auto-submits after about 1.2 s of silence once speech is heard (10 s no-speech and 30 s maximum caps); the manual button still works.
- Shadowing targets the first sentence of the reply, ends on silence (15 s cap), scores punctuation- and case-insensitively, and uses the native speech runtime on desktop instead of the browser Whisper path.

### Security

- Electron renderer receives a Content-Security-Policy for `file://` responses: no string eval, WebAssembly only via `wasm-unsafe-eval`, no remote script or connect origins, and `object-src`, `base-uri`, `form-action`, `frame-src` set to `'none'`.
- Public repository excludes private development evidence, credentials, recordings, machine-specific logs, model weights, installers, app bundles, runtime archives, and generated wheels.
- GitHub Actions use full commit SHA pins and read-only default permissions.

### Known limitations

- No signed or notarized public application release is available.
- Native runtime and model artifacts require artifact-specific provenance and licensing review before publication.
- Platform hardware, signing, notarization, and store-release gates remain separate from source publication.
