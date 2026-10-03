# Changelog

All notable public changes to OpenCoach are documented here.

## [Unreleased]

### Added

- New public source repository with a clean, privacy-preserving Git history.
- Apache-2.0 project license, security policy, contribution guide, support policy, and third-party notices.
- Shared local-first browser, Electron, iOS, and Android source tree.
- Typed desktop and mobile voice/runtime contracts.
- Windows WAV-only faster-whisper source preparation from a pinned upstream commit and reviewable patch.
- Automated source, security, documentation, and cross-platform contract tests.

### Fixed

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
