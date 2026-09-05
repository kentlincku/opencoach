# Local-first Web/PWA architecture

## Product contract

All browser-based Voice Practice surfaces share this boundary:

```text
Current device
├─ app UI and lessons
├─ microphone recording
├─ on-device STT
├─ system or on-device TTS
├─ conversation/settings storage
└─ runtime/model cache

Network
└─ user-configured OpenAI-compatible LLM
```

The first app load, explicit app update, and first model download require network access. Once cached, loss of the LLM endpoint must not prevent app startup, lessons, recording, local transcription, local speech output, or history access. Browser audio is never uploaded as an STT fallback.

## Runtime and asset policy

- `npm run build:web` bundles `@huggingface/transformers` and `kokoro-js` into same-origin ESM files.
- Google Fonts and runtime CDN imports are not used.
- English Kokoro voice files are copied from the locked npm package into same-origin assets.
- Whisper and Kokoro repositories are pinned to immutable Hugging Face commit revisions in `apps/web/model-manifest.json`.
- Models load lazily after an explicit user action; startup does not automatically download or compile Whisper.

## Offline and update policy

- `manifest.webmanifest` provides the installable PWA metadata.
- `service-worker.js` pre-caches an atomic, versioned App Shell.
- Navigations use network-first with cached `index.html` fallback.
- Static same-origin assets use cache-first.
- Transformers Cache Storage is the sole owner of pinned model weights; the Service Worker does not duplicate model responses.
- API calls and all non-GET requests bypass the Service Worker. LLM responses are never cached by it.
- App Shell cache versions are replaced on activation. The model cache survives App Shell updates.
- The app requests persistent browser storage and records whether the result is `granted` or `best-effort`.

## Direct API-key credentials

The OpenAI and Gemini quick presets select fixed official OpenAI-compatible Base URLs while retaining one direct API adapter. Browser API keys are bound to the normalized Base URL used when entered. Editing the URL clears both the field and stored key before model discovery; a stored binding mismatch is deleted fail-closed and cannot be revived by changing the URL back.

## HTTP local-model compatibility

The hosted HTTPS PWA and Local Web Mode have these endpoint boundaries:

- **Hosted HTTPS** accepts HTTPS LLM endpoints and, on Chrome 142+, can directly call HTTP loopback and LAN endpoints after the user grants Local Network Access. LAN means RFC1918, link-local, IPv6 ULA/link-local, or `.local`; these requests are annotated with `targetAddressSpace: "local"` and show a cleartext warning. Public Internet HTTP remains blocked.
- **Local Web Mode** runs the same built Web UI at `http://127.0.0.1:8765`, which browsers treat as a trustworthy loopback context. It can directly call HTTP OpenAI-compatible servers on the same computer, such as oMLX at `http://127.0.0.1:8000/v1`.
- `scripts/start-local-web.mjs` binds only `127.0.0.1`, serves static app files, rejects non-GET methods, and never proxies `/v1`, credentials, or conversations.
- Electron continues to use its allowlisted main-process provider broker for local HTTP endpoints.

This remains a browser security boundary, not a CORS workaround. The hosted page relies on Chrome's explicit Local Network Access permission and never proxies the request. Browsers without that feature may still reject the connection.

## Cloud API presets

OpenAI與Google Gemini都使用同一個OpenAI-compatible API Key流程。Gemini preset固定為`https://generativelanguage.googleapis.com/v1beta/openai`；API Key會綁定normalized endpoint，切換preset或修改端點時清除。Gemini API quota與billing不使用Gemini Advanced等消費型訂閱額度。

## Custom lesson library

The built-in seven lessons are starter content only. In **Systematic Lessons**, open **Manage / Import / Export** to edit the local JSON library, import a backup in merge or replace mode, export it, or restore the starter library. No LLM endpoint is required.

```json
{
  "schemaVersion": 1,
  "lessons": [
    {
      "id": "travel-check-in",
      "title": "Hotel Check-in",
      "level": "Beginner",
      "objectives": ["Confirm a reservation", "Ask about breakfast"],
      "opening_line": "Welcome to the hotel. How may I help you?"
    }
  ]
}
```

IDs must be unique and contain only letters, digits, `_`, or `-`. Imports are validated and capped at 100 lessons / 1 MiB; this limit is larger than the maximum valid export so every app-generated backup can be restored. Imported text is escaped before HTML rendering. Lesson content and completion progress stay in browser storage; an exported file is the portable backup.

## Platform constraints

- Microphone access and PWA installation on phones require HTTPS. `localhost` applies only to the current device.
- Chrome 142+ HTTPS pages can call an HTTP loopback or LAN LLM after Local Network Access permission is granted; the endpoint still needs appropriate CORS behavior. LAN HTTP exposes keys and conversations as cleartext on the network and should be used only on trusted LAN/VPN links. Other browsers may require Local Web Mode or Electron.
- iOS may evict browser storage under pressure even after a persistence request. PWA storage is therefore best-effort, not equivalent to an app-private native model directory.
- System TTS is used only when the browser reports `localService === true`; otherwise speech is disabled with a prompt to install a local OS voice. Non-iOS browsers may alternatively select Kokoro.
- iOS Browser目前停用Kokoro.js並使用確認為本機的System Voice；上游`hexgrad/kokoro#280`仍在追蹤iOS 26.1卡住Generating的問題。非iOS Browser的Kokoro效能仍需真機驗收。
- Capacitor remains the follow-up option when durable model storage or native background/permission behavior becomes a hard product requirement.

## Verification gates

```bash
npm test
npm audit --audit-level=high
npm run dist:dir
```

Release checks must also verify:

1. Browser imports both generated same-origin bundles.
2. A controlled PWA reload succeeds after the static server is stopped.
3. Startup makes no Whisper/Hugging Face request before an explicit speech action.
4. Electron package contains the generated PWA/vendor/voice assets but not duplicate build-only ML dependencies.
5. iPhone Safari and Android Chrome complete microphone, Whisper, System TTS, optional Kokoro, memory-pressure, and offline-restart tests before mobile support is promoted beyond Beta.
6. Hosted Chrome with Local Network Access permission, and Local Web Mode as fallback, discover models and complete chat against a loopback-only HTTP OpenAI-compatible endpoint without a proxy.
