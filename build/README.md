# Desktop build resources

`icon-source.svg` is the only hand-maintained icon. `npm run build:icons` reproducibly creates PNGs and a real ICO on any supported Node platform; on macOS it also uses Apple's `iconutil` to create `icon.icns`. Linux does not create or claim to validate ICNS.

The `electron-builder.yml` `files` section is an allowlist. Python runtimes and models are intentionally excluded and installed later from trusted bundled manifests.
