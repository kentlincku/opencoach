# Release status

OpenCoach currently publishes source only. There is no signed, notarized, production-supported binary release.

## Source publication

The public source snapshot contains the shared web application, Electron desktop code, iOS and Android shells, native Python voice runtime source, contracts, tests, and build scripts.

## Binary publication boundaries

| Artifact class | Status |
|---|---|
| Browser static build | Build from source |
| Windows installer / portable app | Engineering validation in progress; not published |
| Windows native runtime and models | Not stored in Git; artifact-specific licensing and provenance required |
| macOS app/runtime | Packaging source available; signing, notarization, and license gates not complete |
| iOS app | Requires developer signing and real-device verification |
| Android app | Requires release signing and real-device verification |

## Engineering artifacts

Locally produced artifacts must be treated as unsigned engineering builds unless their exact hashes are listed in a signed public release. A passing source test does not establish signing, notarization, hardware, model, or store-release status.

## Models

No model weights or voice embeddings are included. A future release must publish a separate manifest containing exact artifact hashes, tree digests, source URLs, and licenses.
