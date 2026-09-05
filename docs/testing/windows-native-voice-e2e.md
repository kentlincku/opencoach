# Windows Native Voice Runtime Packaging & E2E Verification

## Summary

This document specifies and records the verification of the Windows Native Voice Runtime on `feat/windows-native-voice-runtime`.

## Architecture & Execution Provider Decision

1. **Hardware Spike & Execution Provider**:
   - Tested `DmlExecutionProvider` vs `CPUExecutionProvider` on AMD64 Windows platform using ONNX Runtime.
   - Finding: DirectML fails in `DirectML.dll` on Kokoro's acoustic encoder ConvTranspose operator (`0x80070057 E_INVALIDARG` / `0xC0000005 STATUS_ACCESS_VIOLATION`).
   - Finding: `CPUExecutionProvider` achieves 100% stability with Real-Time Factor (RTF) of ~0.89 (<= 1.0 threshold) on multi-core AMD64.
   - Decision: Windows default execution provider is pinned to `CPUExecutionProvider`.
   - UI status truthfully reflects `Kokoro Native CPU`.

2. **Native Runtime Packaging**:
   - Python 3.11 voice runtime packaged into a standalone onedir distribution via PyInstaller:
     `dist/voice-runtime/voice-runtime.exe`
   - Verified with `scripts/check-windows-runtime.mjs` ensuring PE32+ x64 binary header and sha256 sorted tree digest.

3. **Electron IPC & Fallback Routing**:
   - `ElectronRuntime` communicates via `preload.cjs` -> `main.cjs` -> `SidecarClient`.
   - If the native sidecar is unavailable or fails, Windows Electron strictly falls back to System Voice without initializing or importing renderer Kokoro/ONNX.

4. **Process Tree Lifecycle & Resource Cleanup**:
   - On exit or stop, the entire process tree is terminated using `taskkill.exe /PID <pid> /T /F` to prevent orphan Python worker processes.
   - Temporary audio files are cleaned up in `finally` blocks.
   - Cancellation immediately aborts in-flight requests without leaking promises.

## Automated Verification

- Contract test suite:
  ```powershell
  python -m unittest discover -s tests -p "test_*.py"
  python -m unittest native.python.tests.test_kokoro_onnx_backend native.python.tests.test_server -v
  npm test
  ```
- Packaged App Native Voice verification:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-windows-product-e2e.ps1 -NativeVoice -ExpectedCodeSha <HEAD_SHA>
  ```
