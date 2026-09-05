# Install on macOS (Apple Silicon beta)

A release must contain both DMG/ZIP and `SHA256SUMS.txt`. Verify the checksum before opening. Drag **Voice Practice.app** to Applications and launch normally; do not bypass Gatekeeper. Microphone access is requested only when recording.

## Desktop Lite with oMLX

macOS Electron App connects directly to local oMLX via a secure Main Process IPC broker, without Safari Mixed Content, CORS, or Local Network Access dialogs:

1. Start oMLX listening on `127.0.0.1:8000` (default loopback).
2. Open Settings in Voice Practice.
3. In Direct API presets, choose **oMLX（這台Mac）** (`http://127.0.0.1:8000/v1`).
4. API Key is not required for local endpoints and may remain blank.
5. Click **從端點取得模型** to fetch available models. If connection is refused, confirm oMLX is running on port 8000 listening on `127.0.0.1`.

## Embedded Native Voice Runtime (Apple Silicon)

Engineering builds embed the verified Apple Silicon standalone voice runtime (MLX Whisper & Kokoro) directly inside the App bundle (`Voice Practice.app/Contents/Resources/runtime`). Packaged desktop applications use this embedded runtime out-of-the-box without requiring external network downloads or global Python environments.

## Local Build & Packaging

You can build and package the macOS arm64 DMG and ZIP locally:

```bash
npm ci
npm run build:icons
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack:mac
node scripts/write-checksums.mjs dist
```

Packaged artifacts will be placed in `dist/`:
- `Voice-Practice-0.2.0-beta.1-arm64.dmg`
- `Voice-Practice-0.2.0-beta.1-arm64.zip`
- `dist/mac-arm64/Voice Practice.app`
- `SHA256SUMS.txt`

To uninstall, quit the app, remove it from Applications, then optionally remove its user-data directory to delete downloaded runtimes/models. This also removes local app settings.
