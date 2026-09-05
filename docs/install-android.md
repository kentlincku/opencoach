# Android debug install and Internal Beta gate

## Build and install a debug APK

Prerequisites: JDK 17 and Android SDK 36 (`platforms;android-36`, `build-tools;36.0.0`).

```bash
cd apps/android
./gradlew testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The `syncBundledWeb` Gradle task copies `apps/web` read-only into generated Android assets.
Do not manually edit generated assets and do not add them to Git.

## Security and data flow

```text
fixed appassets HTTPS main frame
  -> origin-scoped WebViewCompat message listener
  -> strict Kotlin schema (models/chat/credential.has-set-clear)
  -> local-network permission gate
  -> EndpointPolicy + LAN-only DNS + manual redirect validation
  -> OkHttp -> selected LAN OpenAI-compatible endpoint
```

- JavaScript cannot provide an HTTP method, headers, or a raw request URL and cannot read a
  credential. Provider responses contain only model IDs, chat text, booleans, and stable errors.
- API keys are AES-256-GCM envelopes. The Android Keystore key never leaves Keystore; provider
  ID plus normalized endpoint are authenticated associated data. Credential preferences are
  excluded from backup/device transfer.
- Requests permit loopback, RFC1918, IPv4 link-local, IPv6 ULA/link-local, and `.local` only.
  DNS results are rechecked, public HTTP/HTTPS and URL userinfo/query/fragment fail closed, and
  redirects stay on the validated origin.
- WebView remote resource requests, navigation, popups, file/content access, and Web permission
  requests are blocked. Native OkHttp is the only LAN provider path.
- The app requests no microphone permission in this shell packet. Android local voice remains a
  separate physical-device task and must not be inferred from the networking bridge.

## Android 16 / Android 17 permission adapter

The checked-in target is SDK 36. The adapter intentionally separates device SDK from target SDK:

| Device / target | Adapter behavior |
|---|---|
| device <= 35 | no additional runtime LAN permission |
| device 36+, target 36 | `NEARBY_WIFI_DEVICES` |
| device 37+, target 36 | compatibility path remains `NEARBY_WIFI_DEVICES` |
| device 37+, target 37+ | `ACCESS_LOCAL_NETWORK` |

When permission is absent, `models` and `chat` return
`LOCAL_NETWORK_PERMISSION_REQUIRED` with `OPEN_APP_SETTINGS` and make zero provider calls.
After granting permission, retry without reinstalling.

**Evidence boundary:** SDK 36/37 behavior above is the versioned repository policy and unit-test
contract. It is **NOT_RUN on a physical Android 16/17 device** in this handoff and must be checked
against the final platform release behavior before support claims or target SDK 37 promotion.

## Play Internal Beta

Pull requests never receive signing secrets and only build/test debug artifacts. A protected
`android-v*` tag enters the `android-internal` environment. The release job fails closed unless
all four signing secrets exist, writes the keystore only to a temporary runner file, builds the
signed AAB, and emits a SHA-256 checksum. No keystore or release password belongs in Git or logs.

Promotion is blocked until the physical-device checklist, Data Safety review, signed-AAB install
and upgrade, permission revoke/regrant, LAN models/chat, and rollback all pass. Google Play upload
is deliberately not automated before those gates are evidenced.