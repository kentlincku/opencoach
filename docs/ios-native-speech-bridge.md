# OpenCoach iOS native speech bridge, version 1

Optional capability: `window.voiceNativeBridge.nativeSpeech === true`. This supplements the shared System Speech playback path on iOS; it does not advertise native STT. Browser, Android, and Electron retain their existing runtime and provider routing. iPhone-only settings are gated by `nativeSpeech` or `appleFoundationModels`, never by the mere presence of `voiceNativeBridge`.

All messages pass the existing trusted bundled main-document and document-generation checks. Speech callbacks recheck the initiating URL and trusted current document before delivery. JavaScript cannot select files, audio routes, native classes, or network destinations. Callback arguments use named JavaScript data arguments.

| Operation | Request | Result |
|---|---|---|
| `speech.voices` | `id`, `operation` | `voices`: installed English voices with `id`, `name`, `language`, `quality` |
| `speech.speak` | `id`, `operation`, `text`, optional `voiceId`, `language`, `rate` | `finished: true`, `startLatencyMs`; resolves after native didFinish |
| `speech.stop` | `id`, `operation` | `stopped: true`; settles pending speech with `SPEECH_CANCELLED` |

The id must be a nonempty string of at most 200 characters. Speak accepts no other keys. Text is nonempty and at most 12,000 UTF-8 bytes. Optional language and voiceId must be strings. Language must be English (`en-` prefix). Rate must be a finite JSON number, excluding booleans, from 0.6 to 1.4 relative to the system default rate. An explicit voice must be installed and English. Automatic selection prefers the highest installed quality, then the requested language (default en-US).

`window.__nativeSpeechStarted(id, data)` reports native didStart with voiceName, quality, and elapsed milliseconds. It does not measure acoustic speaker onset. Errors include `INVALID_SPEECH_REQUEST`, `NATIVE_VOICE_UNAVAILABLE`, `SPEECH_CANCELLED`, `SPEECH_START_TIMEOUT`, and `UNKNOWN_SPEECH_OPERATION`. System audio-session errors also reject playback.

The native service owns one utterance. Replacement settles the old utterance before starting the new one. Stop, navigation, disposal, audio interruption, and background entry release playback/audio session. Late delegate events are rejected by utterance identity; late bridge events are rejected by document generation, URL trust, and UI playback token. A 10-second watchdog rejects speech that never starts. The UI stops the active conversation on background entry and before preview, preventing competing microphone capture.

## Build and verification boundaries

`NativeSpeechService.swift` and `ContentView.swift` belong to the iOS app and Xcode XCTest sources. The shared `ScriptBridgeHandler.swift` is also reached by the existing VoicePracticeCore symlink; its app-only speech references and the UIKit app tests are guarded by `os(iOS) && !SWIFT_PACKAGE`. SwiftPM builds retain the existing provider/navigation bridge without depending on the UIKit speech service. No new symlink or package dependency is required.

Tests cover Swift input validation, device start/finish/cancellation, production WKWebView voice-list/layout, Node playback-token and preview ownership, platform capability gating, and portable source membership. Run Node contracts from the repository root:

```bash
node --test tests/ios-native-speech.test.cjs tests/ios-apple-intelligence-provider.test.cjs tests/provider-settings.test.cjs
```

These are source/JavaScript contract checks, not a claim that an iOS artifact has compiled or run. Execute the `VoicePractice` Xcode test scheme on a simulator for bridge/layout coverage and a physical device for speech and Foundation Models checks. The production WebView test awaits the public asynchronous settings handler. The Foundation Models two-turn test skips when the model is unavailable and logs only availability, latency, and reply length, not prompt/reply contents.

Higher-quality voice downloads, audible output quality, background/interruption behavior on hardware, native compilation, signing/distribution, and STT are separate verification boundaries. See [iOS installation](install-ios.md).
