# Release status

OpenCoach publishes source plus unsigned engineering pre-releases of the desktop app on GitHub Releases. There is no signed, notarized, production-supported binary release.

## Source publication

The public source snapshot contains the shared web application, Electron desktop code, the iOS shell, native Python voice runtime source, contracts, tests, and build scripts. Android was removed in v0.3.0-beta.1.

## Binary publication boundaries

| Artifact class | Status |
|---|---|
| Browser static build | Build from source |
| macOS app (v0.3.0-beta.1) | Ad-hoc signed, not notarized arm64 DMG/ZIP built by `release.yml` from pinned public sources; voice runtime included, no model weights; first launch needs Open Anyway |
| macOS speech models | Downloaded in the App from pinned Hugging Face / GitHub revisions, verified by SHA-256 |
| Windows installer / portable app | Latest is v0.2.0-beta.1; not rebuilt for v0.3.0 |
| iOS app | Source only; users sign and install with their own Apple ID in Xcode |

## Engineering artifacts

Locally produced artifacts must be treated as unsigned engineering builds unless their exact hashes are listed in a signed public release. A passing source test does not establish signing, notarization, hardware, model, or store-release status.

## Models

Model weights, voice embeddings, installers and packaged runtimes are not stored in Git, and no model weights are included in the App. `resources/macos-model-packs.json` pins each downloadable model to exact upstream URLs, per-file SHA-256 values, tree digests, and licenses; the App shows size and license before download.
