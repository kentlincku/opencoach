# Install on macOS (Apple Silicon beta)

OpenCoach v0.3.0-beta.1 is an unsigned engineering pre-release for Apple Silicon Macs (arm64), macOS 13 or later.

## Download and verify

1. From the GitHub release, download `Voice-Practice-0.3.0-beta.1-arm64.dmg` (or the `.zip`) and `SHA256SUMS.txt`.
2. Verify the checksum before opening:
   ```bash
   shasum -a 256 -c SHA256SUMS.txt --ignore-missing
   ```
3. Open the DMG and drag **Voice Practice.app** to Applications.

## First launch (Gatekeeper)

The App is ad-hoc signed by the public build workflow and is **not signed with an Apple Developer ID or notarized**. macOS therefore blocks the first launch:

1. Open **Voice Practice** from Applications. macOS shows "Apple could not verify 'Voice Practice' is free of malware…". Choose **Done** (not *Move to Trash*).
2. Open **System Settings → Privacy & Security**. Near the bottom it says "'Voice Practice' was blocked to protect your Mac." Click **Open Anyway** and confirm with your password or Touch ID.
3. Choose **Open** in the final prompt. Later launches open normally.

Do not disable Gatekeeper system-wide. Only open a build whose checksum you verified. If macOS instead says the App "is damaged", the download is incomplete or modified: delete it and download it again.

Microphone and speech-recognition access are requested only when you start recording.

## Speech models (downloaded in the App)

The App contains the voice runtime but **no speech model weights**. Open **Settings → speech models** and install:

- one speech-to-text model (Whisper tiny / base / small / large-v3-turbo, MLX format, from Hugging Face), and
- the Kokoro text-to-speech model (from GitHub).

Each download is pinned to an exact upstream revision, shows its size and license before you agree, and is verified by SHA-256 before use. Once installed, models are reused offline. Until both are ready you can still type to the coach.

## Connect a local LLM (oMLX example)

1. Start oMLX (or another OpenAI-compatible server) listening on `127.0.0.1:8000`.
2. In **Settings**, choose the **oMLX（這台Mac）** preset (`http://127.0.0.1:8000/v1`). Local endpoints need no API key.
3. Click **從端點取得模型** to fetch the model list, pick a model, and save.

## Build it yourself

The release workflow builds the App from pinned public sources only. You can run the same pipeline locally (about 20–30 minutes; needs Xcode command-line tools, Node 22, Python 3.11 and `uv`):

```bash
npm ci
npm run build:icons
bash scripts/ci-pack-macos.sh "$PWD/.build/mac"
# outputs: .build/mac/release/Voice-Practice-<version>-arm64.dmg and .zip
```

`scripts/ci-build-macos-runtime.py` fetches every runtime input listed in `spikes/packaged-runtime/r56-acquisition.lock.json` and checks its size and SHA-256 before use.

## Uninstall

Quit the App and delete it from Applications. To also remove downloaded models and settings, delete `~/Library/Application Support/Voice Practice`.
