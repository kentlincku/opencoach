# Android privacy and Play Data Safety release checklist

This checklist describes the current shell, not future native voice features.

- [ ] Confirm the app sends model-list requests and conversation text only to the LAN endpoint the
      user configured. Document that the operator of that endpoint controls retention.
- [ ] Confirm API keys stay in Keystore-backed AES-GCM storage and are transmitted only as an
      authorization header to the exact endpoint binding.
- [ ] Confirm no analytics, advertising SDK, crash upload, remote JavaScript, cloud speech, contacts,
      location, photos, files, or background collection was added.
- [ ] Confirm `INTERNET`, `NEARBY_WIFI_DEVICES`, and future target-37
      `ACCESS_LOCAL_NETWORK` declarations match tested release behavior and store disclosure.
- [ ] Confirm microphone is not declared for this shell. Revisit Data Safety and privacy text before
      any native voice implementation requests it.
- [ ] Confirm credential preferences are excluded from cloud backup/device transfer and no secret,
      prompt, reply, private endpoint, or user path appears in logs, symbols, screenshots, evidence,
      SBOM, or workflow output.
- [ ] Run Network Inspector plus an independent packet capture for allow, deny, offline, relaunch,
      and failure paths; attach only redacted SHA-bound results.
- [ ] Review AAB permissions and SDK inventory, Play pre-launch report, mapping artifact, checksum,
      versionCode monotonicity, upgrade, uninstall-data removal, and rollback.

No Data Safety declaration is accepted solely from source inspection. Final answers require the
protected signed build and physical-device observation.