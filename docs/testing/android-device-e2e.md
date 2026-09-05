# Android physical-device E2E checklist

Record device model, Android build/API, WebView version, app version/SHA, endpoint software,
network topology, and sanitized timings. Never record credentials, prompts, replies, or private
hostnames/IPs.

## Shell and bridge

- [ ] Install debug APK from a clean state; known Voice Practice UI renders from appassets.
- [ ] Airplane/offline launch renders bundled UI with no remote JavaScript request.
- [ ] External navigation, popup, iframe bridge invocation, `file:` and `content:` probes fail.
- [ ] `models` and `chat` reach an allowlisted LAN fixture through native OkHttp, independent of
      CORS/Chrome Local Network Access.
- [ ] Public IPv4/IPv6, public DNS, unsafe scheme, userinfo, query, fragment, oversized request,
      oversized response, and cross-origin redirect probes return stable failures.
- [ ] A same-origin relative redirect is revalidated and bounded; redirect loops fail.

## Credentials

- [ ] Set/has/replace/clear succeeds for one endpoint; no plaintext read API exists.
- [ ] Same provider on another host, port, scheme, or base path cannot reuse the envelope.
- [ ] Web storage, `chrome://inspect`, logcat, crash output, backup, and network captures contain no
      secret. Uninstall removes the encrypted preference and Keystore alias.

## Permission and lifecycle

- [ ] On Android 16/SDK 36, deny the prompted policy permission: packet capture shows zero model
      traffic and UI gets actionable recovery; grant and retry without reinstalling.
- [ ] On Android 17 with target 37 test build, repeat for `ACCESS_LOCAL_NETWORK`.
- [ ] Revoke from Settings, foreground app, verify zero traffic, restore and retry.
- [ ] Rotate Wi-Fi, background/foreground, process-kill/relaunch, and WebView update without stale
      bridge replies or credential exposure.

## Task 14 voice boundary

- [ ] Microphone/STT/TTS/Stop/audio interruption/memory pressure/network-blocking tests are run only
      after a separately reviewed in-process native voice backend exists.
- [ ] Do not label `SpeechRecognizer` local without explicit on-device availability plus blocked-
      network packet evidence. Do not claim a sidecar PID on Android.

## Release gate

- [ ] Protected workflow produces a signed AAB, mapping, and matching checksum.
- [ ] Internal track fresh install, upgrade, revoke/regrant, LAN fixture, crash recovery, and rollback
      pass on the supported device matrix.
- [ ] [`../android-privacy-data-safety.md`](../android-privacy-data-safety.md) matches observed traffic.

Current handoff status: Emulator **NOT_RUN**; physical Android **NOT_RUN**; signed AAB/Internal
Testing **NOT_RUN**. These boxes require retained, sanitized, SHA-bound evidence before promotion.