# Packaged runtime spike

This directory is a reproducible **candidate build**, not evidence that a runtime is releasable.

Run on macOS arm64 or Windows x64 with Python 3.11 and the platform backend dependencies installed:

```sh
python spikes/packaged-runtime/build-runtime.py --dry-run
python spikes/packaged-runtime/build-runtime.py
```

The output is PyInstaller `onedir`. Before publishing it, use a clean account without Python/uv to run `runtime.health`, real STT, and real TTS; record startup/RSS/size, inspect native libraries, generate licenses/SBOM, and review model redistribution rights. Linux cannot build or validate either supported native runtime.
