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

### Security

- Public repository excludes private development evidence, credentials, recordings, machine-specific logs, model weights, installers, app bundles, runtime archives, and generated wheels.
- GitHub Actions use full commit SHA pins and read-only default permissions.

### Known limitations

- No signed or notarized public application release is available.
- Native runtime and model artifacts require artifact-specific provenance and licensing review before publication.
- Platform hardware, signing, notarization, and store-release gates remain separate from source publication.
