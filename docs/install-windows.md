# Install on Windows 10/11 x64 (beta)

A release may provide a per-user Setup EXE and a Portable EXE with `SHA256SUMS.txt`. Verify checksums first. The installer does not require administrator access and does not modify PATH. Portable mode still stores runtime/model assets in the Electron user-data directory, not beside the executable.

Unsigned CI artifacts are engineering artifacts and can trigger SmartScreen; disabling Defender/SmartScreen is not a supported installation step. Public releases require a valid Authenticode signature verified with `Get-AuthenticodeSignature` on Windows. Runtime/model downloads may be unavailable while manifests are unpublished; the UI and system/browser fallbacks should still start.

Use Apps & Features or the generated uninstaller to remove Setup builds. Remove the user-data directory separately only if you also want to erase downloaded models, runtimes, and settings.

## Development run from source

Requirements: Node.js 22, Python 3.11, [`uv`](https://docs.astral.sh/uv/), PowerShell.

```powershell
git clone https://github.com/kentlincku/opencoach.git
cd opencoach
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
$env:VOICE_RUNTIME_PYTHON = "$PWD\.venv\Scripts\python.exe"
npm start
```

`setup-windows.ps1` creates `.venv`, installs `native/python/requirements-windows.txt`, downloads the pinned Kokoro ONNX assets with SHA-256 verification, and runs `npm ci --include=dev`. Use `-VerifyAssetsOnly` to re-check the downloaded assets without reinstalling.

## Engineering build (Setup EXE and Portable EXE)

Run from a clean checkout at the repository root:

```powershell
npm ci
npm run build:icons
npm test
$sha = (git rev-parse HEAD).Trim()
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-and-verify-windows-package.ps1 -ExpectedCodeSha $sha
```

The driver refuses a dirty worktree or a SHA mismatch, runs `npm run pack:win`, writes `dist\SHA256SUMS.txt` and `dist\SOURCE_SHA.txt`, then smoke-tests the unpacked app, the Portable EXE, and an isolated NSIS install/uninstall. Outputs:

- `dist\Voice-Practice-Setup-<version>-x64.exe`
- `dist\Voice-Practice-Portable-<version>-x64.exe`
- `dist\SHA256SUMS.txt`

To build only (no verification): `npm run pack:win`. The optional native voice runtime is built separately with `scripts\build-windows-runtime.ps1`.
