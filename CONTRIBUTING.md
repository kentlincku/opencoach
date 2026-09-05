# Contributing to OpenCoach

Thank you for contributing.

## Development setup

Requirements:

- Node.js 22 and npm
- Python 3.11+
- `uv` for native Python runtime work
- platform SDKs only when changing iOS or Android code

```bash
npm ci
npm test
```

Run `npm run build:web` after changing browser modules or generated web assets.

## Pull requests

Keep each pull request focused. Include:

- motivation and affected platforms
- trust boundaries or persisted data changed
- commands actually run and exit status
- tests added or updated
- hardware/platform verification that was run
- explicit `NOT_RUN` entries for gates that were not exercised

Do not claim a platform, signing, notarization, model, microphone, or packaged-product gate passed without real execution evidence.

## Security-sensitive changes

Changes to these areas require focused negative tests:

- Electron IPC and preload APIs
- OAuth, API keys, safe storage, Keychain, or Android Keystore
- WebView navigation and native message bridges
- local endpoint allowlists
- runtime/model archive extraction and path validation
- process launch environments and cancellation
- release workflows and signing boundaries

Never weaken sender, origin, archive, hash, or path validation merely to make shutdown or packaging tests pass.

## Repository hygiene

Do not commit:

- `.env` files, tokens, cookies, credentials, recordings, or private keys
- personal absolute paths, device identifiers, internal hostnames, or private logs
- installers, app bundles, runtime/model archives, model weights, or generated wheels
- `node_modules`, Python environments, caches, or build outputs

Use placeholders such as `$REPO`, `$HOME`, and `[REDACTED_DEVICE]` in documentation and logs.

## Licensing

By contributing, you agree that your original contribution is licensed under Apache-2.0 unless a clearly identified imported component requires another compatible license. Preserve upstream copyright and license notices. Explain the exact source and modification history of vendored or derived code.
