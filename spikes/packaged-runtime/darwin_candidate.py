"""Darwin arm64 offline candidate producer.

The producer records a versioned, untrusted candidate for the real packaged
speech profile. It reads only a caller-owned local tree. The Node consumer in
``scripts/validate-darwin-candidate-r23.cjs`` rechecks this tree with the
shared runtime inventory rules before the candidate is usable as evidence.

No download, model acquisition, manifest publication, signing, or native
execution happens here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from urllib.parse import urlparse


CONTRACT = "R23_DARWIN_CANDIDATE_V2"
SCHEMA_VERSION = 2
PLATFORM = "darwin"
ARCH = "arm64"
STATUS_MISSING = "INPUTS_MISSING"
STATUS_UNTRUSTED = "CANDIDATE_NOT_TRUSTED"
ENTRYPOINT = "bin/voice-runtime"
STT_ROOT = "models/mlx-whisper"
ONNX_MODEL = "models/kokoro-onnx/model.onnx"
ONNX_VOICES = "models/kokoro-onnx/voices.bin"
LICENSE_PATH = "LICENSE"
NOTICE_PATH = "NOTICE"
MAX_FILES = 4096
MAX_DIRECTORIES = 4096
MAX_DEPTH = 64
MAX_PATH_BYTES = 240
MAX_SEGMENT_BYTES = 100
MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
MAX_CANDIDATE_JSON_BYTES = 1024 * 1024
CHUNK = 64 * 1024
COMPONENT_RE = re.compile(r"[A-Za-z0-9_.+@(),-]+")
SHA40 = re.compile(r"^[a-f0-9]{40}$")
SHA64 = re.compile(r"^[a-f0-9]{64}$")


def _fail(message: str) -> None:
    raise ValueError(f"darwin_candidate: {message}")


def _same_identity(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        before.st_dev == after.st_dev
        and before.st_ino == after.st_ino
        and before.st_nlink == after.st_nlink
        and before.st_size == after.st_size
        and before.st_mtime_ns == after.st_mtime_ns
        and before.st_ctime_ns == after.st_ctime_ns
    )


def _physical_dir(path: Path, require_private: bool = False) -> Path:
    try:
        listed = path.lstat()
    except OSError as exc:
        _fail(f"cannot stat directory {path}: {exc}")
    if stat.S_ISLNK(listed.st_mode):
        _fail(f"symlink directory rejected: {path}")
    if not stat.S_ISDIR(listed.st_mode):
        _fail(f"not a directory: {path}")
    if hasattr(os, "getuid") and listed.st_uid != os.getuid():
        _fail(f"directory is not caller-owned: {path}")
    if require_private and stat.S_IMODE(listed.st_mode) != 0o700:
        _fail(f"directory is not mode 0700: {path}")
    return Path(os.path.realpath(path))


def _parent_identity(value: os.stat_result) -> tuple[int, int, int, int]:
    return (value.st_dev, value.st_ino, value.st_uid, stat.S_IMODE(value.st_mode))


def _open_private_parent(path: Path) -> dict[str, object]:
    """Open and retain the exact private directory used for candidate output."""
    canonical = _physical_dir(path, require_private=True)
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd: int | None = None
    try:
        fd = os.open(canonical, flags)
        listed = canonical.lstat()
        opened = os.fstat(fd)
        if (not stat.S_ISDIR(listed.st_mode) or stat.S_IMODE(listed.st_mode) != 0o700
                or _parent_identity(listed) != _parent_identity(opened)):
            _fail(f"output parent changed before open: {canonical}")
        return {"path": canonical, "fd": fd, "identity": _parent_identity(opened)}
    except OSError as exc:
        if fd is not None:
            os.close(fd)
        _fail(f"cannot open private output parent {canonical}: {exc}")
    except Exception:
        if fd is not None:
            os.close(fd)
        raise


def _assert_parent_continuity(record: dict[str, object], public_parent: Path) -> None:
    canonical = Path(record["path"])
    fd = int(record["fd"])
    try:
        listed = canonical.lstat()
        held = os.fstat(fd)
        public_canonical = Path(os.path.realpath(public_parent))
    except OSError as exc:
        _fail(f"output parent continuity unavailable: {exc}")
    if (public_canonical != canonical or stat.S_ISLNK(listed.st_mode)
            or not stat.S_ISDIR(listed.st_mode)
            or stat.S_IMODE(listed.st_mode) != 0o700
            or _parent_identity(listed) != record["identity"]
            or _parent_identity(held) != record["identity"]):
        _fail("output parent was replaced or its private identity changed")


def _relative_output_exists(parent_fd: int, name: str) -> bool:
    try:
        os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False
    except OSError as exc:
        _fail(f"cannot inspect candidate output: {exc}")


def _canonical_input_root(value: Path) -> Path:
    if not value.is_absolute():
        _fail("input root must be absolute")
    # Check the supplied node before canonicalizing. This preserves the
    # distinction between a legal /var ancestor and a symlink input root.
    root = _physical_dir(value)
    if not root.is_absolute():
        _fail("input root is not absolute after canonicalization")
    return root


def _safe_relative(value: str) -> str:
    if not isinstance(value, str) or not value or len(value.encode()) > MAX_PATH_BYTES:
        _fail(f"invalid path: {value!r}")
    if "\\" in value or "\x00" in value:
        _fail(f"invalid path: {value!r}")
    parts = value.split("/")
    if not parts or any(not part for part in parts):
        _fail(f"empty path component: {value!r}")
    for part in parts:
        if part in (".", "..") or len(part.encode()) > MAX_SEGMENT_BYTES or not COMPONENT_RE.fullmatch(part):
            _fail(f"unsafe path component in {value!r}")
    return value


def _read_file(path: Path) -> dict[str, object]:
    try:
        listed = path.lstat()
    except OSError as exc:
        _fail(f"cannot stat file {path}: {exc}")
    if stat.S_ISLNK(listed.st_mode):
        _fail(f"symlink rejected: {path}")
    if not stat.S_ISREG(listed.st_mode):
        _fail(f"non-regular file rejected: {path}")
    if listed.st_nlink != 1:
        _fail(f"hardlink rejected: {path}")
    if listed.st_size > MAX_FILE_BYTES:
        _fail(f"file too large: {path}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        _fail(f"cannot open file {path}: {exc}")
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or not _same_identity(listed, opened):
            _fail(f"file identity changed before read: {path}")
        digest = hashlib.sha256()
        size = 0
        while True:
            block = os.read(fd, CHUNK)
            if not block:
                break
            size += len(block)
            if size > MAX_FILE_BYTES:
                _fail(f"file grew beyond limit: {path}")
            digest.update(block)
        after = os.fstat(fd)
        if not _same_identity(opened, after) or size != opened.st_size:
            _fail(f"file changed during read: {path}")
        return {"bytes": size, "sha256": digest.hexdigest()}
    finally:
        os.close(fd)


def _add_node(nodes: dict[str, tuple[str, str]], relative: str, kind: str) -> None:
    folded = relative.casefold()
    previous = nodes.get(folded)
    if previous is not None and (previous != (relative, kind) or kind == "file"):
        _fail(f"path node collision: {relative}")
    nodes[folded] = (relative, kind)


def _scan_root(input_root: Path) -> list[dict[str, object]]:
    _physical_dir(input_root)
    files: list[dict[str, object]] = []
    nodes: dict[str, tuple[str, str]] = {"": ("", "directory")}
    directory_count = 1
    total_bytes = 0

    def walk(directory: Path, relative_directory: str, depth: int) -> None:
        nonlocal directory_count, total_bytes
        if depth > MAX_DEPTH:
            _fail("directory depth limit exceeded")
        try:
            entries = sorted(os.scandir(directory), key=lambda item: item.name)
        except OSError as exc:
            _fail(f"walk failed closed at {directory}: {exc}")
        for entry in entries:
            relative = f"{relative_directory}/{entry.name}" if relative_directory else entry.name
            _safe_relative(relative)
            try:
                listed = entry.stat(follow_symlinks=False)
            except OSError as exc:
                _fail(f"cannot stat entry {relative}: {exc}")
            if stat.S_ISLNK(listed.st_mode):
                _fail(f"symlink rejected: {relative}")
            if stat.S_ISDIR(listed.st_mode):
                _add_node(nodes, relative, "directory")
                directory_count += 1
                if directory_count > MAX_DIRECTORIES:
                    _fail("directory count limit exceeded")
                walk(Path(entry.path), relative, depth + 1)
            elif stat.S_ISREG(listed.st_mode):
                _add_node(nodes, relative, "file")
                identity = _read_file(Path(entry.path))
                total_bytes += int(identity["bytes"])
                if total_bytes > MAX_TOTAL_BYTES:
                    _fail("total byte limit exceeded")
                files.append({"path": relative, **identity})
            else:
                _fail(f"special file rejected: {relative}")

    walk(input_root, "", 0)
    if len(files) > MAX_FILES:
        _fail("file count limit exceeded")
    return sorted(files, key=lambda item: str(item["path"]))


def _tree_digest(files: list[dict[str, object]]) -> str:
    lines = "".join(f"{item['path']}:{item['bytes']}:{item['sha256']}\n" for item in files)
    return hashlib.sha256(lines.encode()).hexdigest()


def _text(value: object, field: str, max_length: int = 2048) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > max_length or any(ord(c) < 0x20 for c in value):
        _fail(f"invalid text at {field}")
    return value


def _https_url(value: object, field: str) -> str:
    text = _text(value, field)
    parsed = urlparse(text)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        _fail(f"invalid https URL at {field}")
    return text


def _validate_provenance(provenance: dict) -> dict:
    if not isinstance(provenance, dict) or set(provenance) != {"sourceRevision", "sourceUrl", "license"}:
        _fail("provenance schema mismatch")
    revision = _text(provenance["sourceRevision"], "sourceRevision", 64)
    if not SHA40.fullmatch(revision) and not SHA64.fullmatch(revision):
        _fail("sourceRevision must be 40 or 64 lowercase hex")
    license_data = provenance["license"]
    if not isinstance(license_data, dict) or set(license_data) != {"spdx", "url"}:
        _fail("license schema mismatch")
    return {
        "sourceRevision": revision,
        "sourceUrl": _https_url(provenance["sourceUrl"], "sourceUrl"),
        "license": {
            "spdx": _text(license_data["spdx"], "license.spdx", 200),
            "url": _https_url(license_data["url"], "license.url"),
        },
    }


def _profile_complete(files: list[dict[str, object]]) -> bool:
    paths = {str(item["path"]) for item in files}
    stt_files = [path for path in paths if path.startswith(STT_ROOT + "/")]
    return all(path in paths for path in [ENTRYPOINT, ONNX_MODEL, ONNX_VOICES, LICENSE_PATH, NOTICE_PATH]) and bool(stt_files)


def _write_all(fd: int, raw: bytes) -> None:
    offset = 0
    while offset < len(raw):
        count = os.write(fd, raw[offset:])
        if not isinstance(count, int) or count <= 0:
            _fail("short candidate write")
        offset += count


def _read_candidate(fd: int, path: Path, expected_size: int, expected_sha256: str) -> dict:
    """Read the just-written candidate from its existing owned descriptor."""
    if expected_size > MAX_CANDIDATE_JSON_BYTES:
        _fail("candidate metadata exceeds bounded JSON limit")
    os.lseek(fd, 0, os.SEEK_SET)
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or opened.st_size != expected_size:
            _fail(f"candidate identity changed before read: {path}")
        data = bytearray()
        digest = hashlib.sha256()
        while True:
            block = os.read(fd, CHUNK)
            if not block:
                break
            data.extend(block)
            digest.update(block)
            if len(data) > MAX_CANDIDATE_JSON_BYTES:
                _fail("candidate metadata grew beyond bounded JSON limit")
        after = os.fstat(fd)
        if (not _same_identity(opened, after) or len(data) != expected_size
                or digest.hexdigest() != expected_sha256):
            _fail("candidate readback size mismatch")
        return json.loads(bytes(data).decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail(f"candidate readback failed: {exc}")
    finally:
        os.lseek(fd, 0, os.SEEK_END)


def produce(input_root: Path, output_path: Path, provenance: dict, entrypoint: str = ENTRYPOINT) -> dict:
    root = _canonical_input_root(Path(input_root))
    output = Path(output_path)
    if not output.is_absolute():
        _fail("output path must be absolute")
    if entrypoint != ENTRYPOINT:
        _fail(f"entrypoint must be {ENTRYPOINT}")
    source = _validate_provenance(provenance)
    parent_record = _open_private_parent(output.parent)
    parent = Path(parent_record["path"])
    parent_fd = int(parent_record["fd"])
    try:
        _assert_parent_continuity(parent_record, output.parent)
        if output.name in ("", ".", "..") or _relative_output_exists(parent_fd, output.name):
            _fail(f"output path already exists: {output}")
        if os.path.commonpath([str(root), str(parent)]) == str(root):
            _fail("candidate output must be outside input root")
        source_repo = Path(__file__).resolve().parents[2]
        if os.path.commonpath([str(source_repo), str(parent)]) == str(source_repo):
            _fail("candidate output must be outside source repository")
        files = _scan_root(root)
        complete = _profile_complete(files)
        status = STATUS_UNTRUSTED if complete else STATUS_MISSING
        candidate = {
        "schemaVersion": SCHEMA_VERSION,
        "contract": CONTRACT,
        "label": "CANDIDATE_NOT_TRUSTED",
        "status": status,
        "platform": PLATFORM,
        "arch": ARCH,
        "backend": {"stt": "mlx-whisper", "tts": "kokoro-onnx", "ttsExecutionProvider": "cpu"},
        "entrypoint": ENTRYPOINT,
        "modelBindings": {
            "sttRoot": {"path": STT_ROOT},
            "onnxModel": {"path": ONNX_MODEL},
            "onnxVoices": {"path": ONNX_VOICES},
        },
        "requiredRoles": {
            "entrypoint": ENTRYPOINT,
            "sttRoot": STT_ROOT,
            "onnxModel": ONNX_MODEL,
            "onnxVoices": ONNX_VOICES,
            "license": LICENSE_PATH,
            "notice": NOTICE_PATH,
        },
        "files": files,
        "treeDigest": _tree_digest(files),
        "bytes": sum(int(item["bytes"]) for item in files),
        "archive": {"status": "NOT_PRODUCED", "bytes": None, "sha256": None},
        "provenance": {
            **source,
            "sourceVerification": "UNVERIFIED",
            "license": {**source["license"], "verification": "UNVERIFIED"},
            "notice": {"path": NOTICE_PATH, "status": "PRESENT" if NOTICE_PATH in {str(item["path"]) for item in files} else "MISSING"},
        },
        }
        raw = (json.dumps(candidate, indent=2, sort_keys=True) + "\n").encode("utf-8")
        if len(raw) > MAX_CANDIDATE_JSON_BYTES:
            _fail("candidate metadata exceeds bounded JSON limit")
        _assert_parent_continuity(parent_record, output.parent)
        # Keep one read/write owner FD and the retained parent FD. Creation is
        # relative to the original directory, so a replacement at the public
        # pathname cannot redirect the write into a new directory.
        flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(output.name, flags, 0o600, dir_fd=parent_fd)
        except OSError as exc:
            _fail(f"cannot create candidate: {exc}")
        try:
            _assert_parent_continuity(parent_record, output.parent)
            _write_all(fd, raw)
            os.fsync(fd)
            _assert_parent_continuity(parent_record, output.parent)
            readback = _read_candidate(fd, output, len(raw), hashlib.sha256(raw).hexdigest())
            _assert_parent_continuity(parent_record, output.parent)
        finally:
            os.close(fd)
        if readback != candidate:
            _fail("candidate readback differs from produced data")
        return candidate
    finally:
        os.close(parent_fd)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Darwin arm64 offline candidate producer; TEST_ONLY / NON_NATIVE")
    parser.add_argument("--input-root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--entrypoint", default=ENTRYPOINT)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--license-spdx", required=True)
    parser.add_argument("--license-url", required=True)
    args = parser.parse_args(argv)
    candidate = produce(
        Path(args.input_root),
        Path(args.output),
        {
            "sourceRevision": args.source_revision,
            "sourceUrl": args.source_url,
            "license": {"spdx": args.license_spdx, "url": args.license_url},
        },
        args.entrypoint,
    )
    print(json.dumps({
        "contract": candidate["contract"],
        "status": candidate["status"],
        "label": candidate["label"],
        "platform": candidate["platform"],
        "arch": candidate["arch"],
        "files": len(candidate["files"]),
        "treeDigest": candidate["treeDigest"],
        "output": str(args.output),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
