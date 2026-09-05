#!/usr/bin/env python3
"""Native-runner spike driver. It does not claim cross-platform output."""
from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def platform_key(system: str | None = None, machine: str | None = None) -> str:
    system = system or platform.system()
    machine = machine or platform.machine()
    normalized = machine.lower()
    if system == "Darwin" and normalized == "arm64":
        return "darwin-arm64"
    if system == "Windows" and normalized in {"amd64", "x86_64"}:
        return "win32-x64-cpu"
    raise ValueError(f"Unsupported native runtime build platform: {system}/{machine}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    key = platform_key()
    command = [sys.executable, "-m", "PyInstaller", "--clean", "--noconfirm", str(Path(__file__).with_name("voice-runtime.spec"))]
    print(f"Native platform: {key}")
    print("Command:", " ".join(command))
    if args.dry_run:
        return 0
    if shutil.which("python") is None and shutil.which("python3") is None:
        raise SystemExit("Python is required on the native build runner")
    subprocess.run(command, cwd=ROOT, check=True)
    import hashlib, json
    binary_name = "voice-runtime.exe" if key.startswith("win32") else "voice-runtime"
    dist_bin = ROOT / "dist" / "voice-runtime" / binary_name
    if dist_bin.is_file():
        content = dist_bin.read_bytes()
        meta = {
            "platform": key,
            "entrypoint": binary_name,
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest()
        }
        (dist_bin.parent / "metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        print("Generated runtime metadata:", meta)
    print("Build created a candidate only; health/STT/TTS and redistribution review remain mandatory.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
