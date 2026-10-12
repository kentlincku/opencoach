# Install on Windows 10/11 x64 (beta)

OpenCoach v0.3.0-beta.3 for Windows is an unsigned engineering pre-release for 64-bit Windows 10/11 (x64 CPU with AVX2).

> This Windows installer was built and tested on the maintainer's Windows machine and uploaded by hand. It was **not** built by GitHub Actions; a reproducible CI build is planned. Verify the checksum before running it.

## Download and verify

1. From the GitHub release, download `OpenCoach-Setup-0.3.0-beta.3-x64.exe` and `SHA256SUMS.txt`.
2. Verify the checksum in PowerShell and compare it with the line in `SHA256SUMS.txt`:
   ```powershell
   (Get-FileHash .\OpenCoach-Setup-0.3.0-beta.3-x64.exe -Algorithm SHA256).Hash.ToLower()
   ```
3. Run the installer. It installs for the current user only, needs no administrator access, and does not change PATH.

The installer is not Authenticode-signed, so SmartScreen may say "Windows protected your PC". Choose **More info → Run anyway** only for a file whose checksum you verified. Do not turn off SmartScreen or Defender.

## Speech models (downloaded in the App)

The App contains the voice runtime (CPU) but **no speech model weights**. Open **Settings → speech models** and install:

- one speech-to-text model (faster-whisper tiny / base / small / large-v3-turbo), and
- the Kokoro text-to-speech model.

Clicking a model's download button starts the download; several downloads can run at once. Size and license are shown on each model card. Every download is pinned to an exact upstream revision and verified by SHA-256 before use; installed models work offline. Changing the speech-to-text model takes effect after restarting the App.

## Connect a local LLM

Any OpenAI-compatible server works, for example LM Studio (`http://127.0.0.1:1234/v1`) or llama.cpp `llama-server` (`http://127.0.0.1:8080/v1`). In **Settings**, enter the endpoint, click **從端點取得模型**, pick a model and save. Local endpoints need no API key.

## Uninstall

Use **Settings → Apps → Installed apps** (or the uninstaller in the install folder). To also remove downloaded models and settings, delete `%APPDATA%\Voice Practice`.

## Build it yourself

On Windows with Node 22 and a Python 3.11 CPU virtual environment containing the pinned speech runtime packages:

```powershell
npm ci
npm run build:web
python -I -B scripts\win-build-local-runtime-cpu.py <resources-dir> <builds-dir>
node scripts\win-pack-model-packs.cjs stage --runtime-build <builds-dir>\build-cpu-NNN --output <stage-dir>
node scripts\win-pack-model-packs.cjs pack --stage <stage-dir> --stage-receipt-sha256 <sha from stage> --output <pack-dir> --nsis
```

`<resources-dir>` holds `acquisition.json`, the misaki lexicons, the Kokoro fp16 model (used only to read its vocabulary) and `silero_vad_v6.onnx`. The CPU build refuses any CUDA/cuDNN library. A one-command, pinned-source build like the macOS one is not available for Windows yet.
