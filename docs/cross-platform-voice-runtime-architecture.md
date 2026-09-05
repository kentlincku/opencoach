# Cross-Platform Voice Runtime Architecture

**Status:** Accepted

## Decision

All product surfaces share one Web UI and one versioned `VoiceRuntime` behavior contract:

```text
capabilities()
transcribe(request)
synthesize(request)
cancel(requestId)
dispose()
```

The product behavior, request IDs, capability schema, stable error codes, cancellation semantics, TTS preference policy, privacy policy, and late-result protection remain platform-independent. Platform adapters differ only at the trusted execution boundary.

```text
Shared Web UI / conversation core
│
├─ BrowserVoiceRuntime
│  └─ browser APIs, auditable local Web runtime, or System Speech
│
├─ DesktopVoiceRuntime
│  └─ ElectronRuntime → typed preload IPC → Main Process → persistent Python sidecar
│     ├─ macOS: MLX Whisper + Kokoro
│     └─ Windows: faster-whisper + Kokoro ONNX
│
└─ MobileVoiceRuntime
   └─ typed WebView bridge → app-scoped native voice service
      ├─ iOS: Swift service + Speech/SpeechAnalyzer, Core ML/MLX Swift, AVSpeechSynthesizer, or verified local TTS
      └─ Android: Kotlin service + platform speech, ONNX Runtime/TFLite, or verified local TTS
```

## Why desktop and mobile use different execution containers

macOS and Windows can launch, monitor, and terminate a separately signed Python runtime. Model residency and cleanup are process-scoped and verified with a sidecar PID.

Normal iOS and Android application sandboxes do not provide the same unrestricted child-process model. Mobile voice inference therefore runs inside the signed application process behind a typed native service. It must not download or execute new code. Downloaded model data is allowed only when its source, revision, size, hash, license, storage location, and activation are verified.

This is an implementation difference, not a product-architecture fork.

## Shared behavioral contract

Every adapter must provide equivalent observable behavior:

1. Capability responses distinguish advertised, selected, loaded, and effective backend/device state.
2. Every operation has a request ID and bounded validated input.
3. `cancel(requestId)` invalidates late results and attempts to stop actual native work.
4. Cancellation cannot trigger cloud or browser fallback after the user pressed Stop.
5. `dispose()` prevents new work and releases platform-owned voice resources.
6. The UI reports the effective engine, not merely the requested preference.
7. Speech remains local unless the user explicitly enables a separately disclosed cloud speech provider.

## Platform lifecycle mapping

| Contract event | macOS / Windows desktop | iOS / Android mobile | Browser / PWA |
|---|---|---|---|
| lazy load | instantiate backend in persistent sidecar | initialize native service/model in app process | initialize browser model/API |
| residency | sidecar process and engine/session | app-scoped actor/service and model instance | page/worker scoped |
| cancel | IPC request plus bounded process/backend termination | cancel native task and invalidate generation | cancel browser task/playback and invalidate generation |
| dispose | observe sidecar exit and clean temp files | cancel tasks, release audio session/model/cache handles | release worker/audio/model resources |
| memory pressure | process RSS/VRAM policy | unload models on memory warning/background policy | browser lifecycle/eviction |
| recovery | distinct sidecar PID when restart is required | recreate service/model after foreground/readiness checks | recreate page/worker model |

A mobile acceptance report must never claim PID reuse. It proves one app-scoped service/model instance instead. A desktop report must not substitute an in-memory mock for observed process termination.

## iOS boundary

```text
Bundled WKWebView
→ canonical-document-bound typed bridge
→ NativeVoiceRuntime Swift protocol
→ actor/service implementation
→ platform STT/TTS backend
```

The Swift contract should be equivalent to:

```swift
protocol NativeVoiceRuntime: Sendable {
    func capabilities() async -> VoiceCapabilities
    func transcribe(_ request: TranscribeRequest) async throws -> Transcript
    func synthesize(_ request: SynthesisRequest) async throws -> AudioResult
    func cancel(requestID: String) async
    func dispose() async
}
```

Requirements:

- Bridge access is limited to the canonical bundled main-frame document and a per-document identity.
- JavaScript cannot choose arbitrary native class names, files, model paths, commands, headers, or endpoints.
- Swift validates payload type and size independently of JavaScript.
- Keychain credentials never enter WKWebView memory.
- Audio permission, microphone lifecycle, `AVAudioSession`, foreground/background transitions, interruption, and memory warnings are handled natively.
- Local model packages are signed into the app or installed as verified data artifacts; executable runtime code is never downloaded.
- Foundation Models affects only the LLM provider and does not implicitly replace STT or TTS.

## Android boundary

Android follows the same mobile contract using a canonical bundled WebView, a typed Kotlin bridge, structured coroutine cancellation, Android audio lifecycle, and Keystore-backed credentials. Backend choices may differ, but JavaScript-visible behavior and errors must remain compatible with iOS and desktop.

## Fallback policy

```text
Browser:
  STT → auditable browser-local engine → typed input
  TTS → System Speech by default; explicit verified Browser Kokoro is optional

Desktop:
  STT → native sidecar backend → approved local fallback → typed input
  TTS → native Kokoro → System Voice

Mobile:
  STT → native in-process backend → typed input
  TTS → verified local native TTS → System Voice
```

No platform may silently upload microphone audio because its local backend failed.

## Verification gates

Before claiming platform support:

- Contract tests use the same capability and error fixtures across Browser, Electron, Swift, and Kotlin adapters.
- Product E2E goes through visible UI controls and the public runtime adapter; direct preload/native service calls are diagnostic only.
- Cancellation proves no stale transcript, reply, or audio reaches the UI.
- Desktop proves sidecar process/session reuse and observed exit.
- Mobile proves native service/model reuse, background/foreground behavior, audio interruption, memory-pressure unload/recovery, and physical-device execution.
- Effective backend/device/provider is captured after real lazy initialization.
- Offline claims require network observation on real hardware.

## Migration rule

The existing iOS typed networking bridge remains valid. Native voice is added as a sibling typed service behind the same document-identity and payload-validation boundary. The current macOS/iOS R3 security rework must finish before expanding its execution scope; native iOS voice implementation receives a separately scoped task packet and physical-device acceptance gate.
