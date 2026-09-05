# Install on Windows 10/11 x64 (beta)

A release may provide a per-user Setup EXE and a Portable EXE with `SHA256SUMS.txt`. Verify checksums first. The installer does not require administrator access and does not modify PATH. Portable mode still stores runtime/model assets in the Electron user-data directory, not beside the executable.

Unsigned CI artifacts are engineering artifacts and can trigger SmartScreen; disabling Defender/SmartScreen is not a supported installation step. Public releases require a valid Authenticode signature verified with `Get-AuthenticodeSignature` on Windows. Runtime/model downloads may be unavailable while manifests are unpublished; the UI and system/browser fallbacks should still start.

Use Apps & Features or the generated uninstaller to remove Setup builds. Remove the user-data directory separately only if you also want to erase downloaded models, runtimes, and settings.
