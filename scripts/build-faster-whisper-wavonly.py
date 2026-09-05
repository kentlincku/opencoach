#!/usr/bin/env python3
"""Prepare the pinned faster-whisper WAV-only source tree for runtime packaging.

The upstream package is MIT-licensed. OpenCoach's WAV-only modifications are
stored as a reviewable patch and are applied to the exact upstream Git commit.
No generated wheel is committed to this repository.
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import tempfile
from pathlib import Path

UPSTREAM_REPO = "https://github.com/SYSTRAN/faster-whisper.git"
UPSTREAM_TAG = "v1.2.1"
UPSTREAM_SHA = "65882eee9f5cdbeeb2d877f1131d48cf241b327d"
EXPECTED_PATCHED_TREE_SHA256 = "f82e8b3bdf9df1eacfa5dc5f9caa5703fd52c72c4b85506af501ff7939a85805"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_digest(root: Path) -> str:
    """Return a stable digest over relative path, size, and file SHA-256."""
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        relative = path.relative_to(root).as_posix()
        record = f"{relative}\0{path.stat().st_size}\0{sha256_file(path)}\n"
        digest.update(record.encode("utf-8"))
    return digest.hexdigest()


def run(*args: str, cwd: Path | None = None) -> str:
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--install-into",
        required=True,
        type=Path,
        help="Destination faster_whisper package directory inside an isolated build venv",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    patch_path = repo_root / "patches" / "faster-whisper-1.2.1-wav-only.patch"
    if not patch_path.is_file():
        raise SystemExit(f"Patch not found: {patch_path}")

    with tempfile.TemporaryDirectory(prefix="opencoach-faster-whisper-") as temporary:
        source = Path(temporary) / "faster-whisper"
        subprocess.check_call(
            ["git", "clone", "--depth", "1", "--branch", UPSTREAM_TAG, UPSTREAM_REPO, str(source)]
        )
        actual_sha = run("git", "rev-parse", "HEAD", cwd=source)
        if actual_sha != UPSTREAM_SHA:
            raise SystemExit(
                f"Upstream identity mismatch: expected {UPSTREAM_SHA}, got {actual_sha}"
            )

        subprocess.check_call(["git", "apply", "--check", str(patch_path)], cwd=source)
        subprocess.check_call(["git", "apply", str(patch_path)], cwd=source)

        package_source = source / "faster_whisper"
        if not package_source.is_dir():
            raise SystemExit("Pinned upstream package directory is missing")

        destination = args.install_into.resolve()
        if destination.name != "faster_whisper":
            raise SystemExit("--install-into must end with the faster_whisper directory name")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(package_source, destination)

        prepared_digest = tree_digest(destination)
        if prepared_digest != EXPECTED_PATCHED_TREE_SHA256:
            raise SystemExit(
                "Patched source tree mismatch: "
                f"expected {EXPECTED_PATCHED_TREE_SHA256}, got {prepared_digest}"
            )

        print(f"UPSTREAM_SHA={actual_sha}")
        print(f"PATCH_SHA256={sha256_file(patch_path)}")
        print(f"PATCHED_TREE_SHA256={prepared_digest}")
        print(f"PATCHED_FILE_COUNT={sum(1 for p in destination.rglob('*') if p.is_file())}")


if __name__ == "__main__":
    main()
