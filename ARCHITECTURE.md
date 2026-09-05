# Architecture

## Principle

Voice Practice 只有一套產品 UI；平台差異由 Runtime Adapter 吸收。

Browser、desktop與mobile voice lifecycle的canonical分工見[`docs/cross-platform-voice-runtime-architecture.md`](docs/cross-platform-voice-runtime-architecture.md)。

跨平台LLM provider、登入產品、credential安全邊界與platform-local brain的canonical分工見[`docs/cross-platform-llm-auth-architecture.md`](docs/cross-platform-llm-auth-architecture.md)。

UI 只依賴以下五個 `VoiceRuntime` 方法：

```text
capabilities()  transcribe()  synthesize()  cancel()  dispose()
```

`createRuntime()` 在純瀏覽器建立 `BrowserRuntime`；偵測到 preload 白名單時建立 `ElectronRuntime`。Electron health 失敗或 native backend 不可用時仍保留 Electron 安全邊界，並透過受限的 Browser／Cloud fallback 繼續運作。`cancel()` 會使尚未完成的 STT/TTS 結果失效，避免停止後的延遲回應更新 UI。

```text
Shared Web UI
  ├─ Browser adapters: Web Speech, WASM/WebGPU, direct API
  ├─ Electron preload (strict allowlist)
  │    ├─ Python voice runtime: pluggable STT/TTS backend registry
  │    └─ ProviderBroker: allowlisted official API endpoints and OS-secured keys
  └─ Mobile typed bridge
       └─ app-scoped Swift/Kotlin native voice and provider services
```

## Desktop request flow

### TTS

```text
VoiceRuntime.synthesize
→ preload voice:tts
→ Electron main
→ SidecarClient JSONL request
→ selected TTSBackend (Kokoro Python / Kokoro ONNX)
→ base64 WAV
→ renderer Audio
```

### STT

```text
MediaRecorder Blob
→ {ArrayBuffer, mimeType, language}
→ preload voice:stt
→ main writes mode-0600 temp audio
→ selected STTBackend (MLX Whisper / faster-whisper)
→ text
→ main deletes temp audio
```

### Provider LLM

```text
renderer model/messages
→ validated preload/main IPC
→ allowlisted Main Process ProviderBroker
→ provider's official API endpoint with OS-secured API key
```

The desktop app supports two provider-specific subscription paths—ChatGPT/Codex and Grok/SuperGrok—through a Main Process `SubscriptionAuthBroker`. Availability requires Voice Practice-owned provider registration; tokens remain in OS `safeStorage` and never cross into the renderer. Other cloud and local models use the shared API/endpoint route.

## Runtime protocol

Requests and responses are newline-delimited JSON. Every response retains the request ID.

```json
{"id":"uuid","method":"tts.synthesize","params":{"text":"Hello","voice":"af_heart","speed":1}}
```

```json
{"id":"uuid","success":true,"result":{"audio":"...","format":"audio/wav","sampleRate":24000}}
```

The sidecar emits one startup event:

```json
{"event":"ready","protocol":1}
```

`runtime.health` 回傳由 `contracts/voice-runtime.schema.json` 定義的 capability contract。查詢 health 不會觸發模型 warm-up：

```json
{
  "protocol": 1,
  "platform": "darwin",
  "arch": "arm64",
  "sttBackends": ["mlx-whisper", "faster-whisper"],
  "ttsBackends": ["kokoro-python", "kokoro-onnx"],
  "selectedStt": "mlx-whisper",
  "selectedTts": "kokoro-python",
  "ready": true,
  "degradedReason": null
}
```

Backend identifier 保留擴充性；前端遇到尚未支援或格式錯誤的回應時，會正規化為 degraded 狀態，而不是嘗試呼叫未知 backend。

Python `BackendRegistry` 只在第一次 STT/TTS 呼叫時建立 backend，之後由常駐 sidecar 重用同一實例。`auto` 在 Apple Silicon 優先 MLX Whisper＋Python Kokoro；其他平台優先 faster-whisper＋Kokoro ONNX。缺少 package 或 ONNX model assets 時回報 `BACKEND_UNAVAILABLE`，server 保持存活並讓 UI 降級。若 lazy 初始化或推論失敗，該 backend 會從後續 health capability 中移除，且同一 sidecar process 不會反覆重試。

stdout is protocol-only; stderr is diagnostics. JSONL 僅公開固定的 first-party input/backend error code；第三方 exception 詳情與 traceback 預設不會送到 Electron console，只有明確設定 `VOICE_RUNTIME_DEBUG=1` 時才輸出 traceback。Fake STT 也使用相同的 runtime-temp path containment。

## Migration status

- Web UI: migrated and shared.
- Browser fallbacks: preserved.
- Native Kokoro: implemented as persistent lazy sidecar.
- Native MLX Whisper: implemented as persistent lazy sidecar with one configured model.
- Typed audio IPC: implemented.
- Runtime capability contract and safe client normalization: implemented.
- BrowserRuntime／ElectronRuntime adapters and runtime factory: implemented.
- Cloud/local models use the shared API/endpoint route; the only subscription exceptions are the capability-gated ChatGPT/Codex and Grok/SuperGrok Desktop adapters. Apple Foundation Models is the only platform-local route.
- Original Gradio implementation: removed from the maintained tree; recoverable from Git history only.
- Pluggable Python speech backends: MLX Whisper、faster-whisper、Kokoro Python、Kokoro ONNX interfaces implemented with lazy reuse.
- Cross-platform native inference: backend code exists; current support claims remain bounded by active platform packets and real-hardware evidence.
