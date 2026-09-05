#!/usr/bin/env python3
"""Persistent JSON-lines voice runtime for Electron.

stdout is protocol-only. Diagnostics go to stderr. Set VOICE_RUNTIME_FAKE=1 to
run the contract without ML dependencies.
"""
from __future__ import annotations

import json
import os
import platform
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

if __package__:
    from .backend_registry import BackendRegistry
    from .backends.base import BackendExecutionError, BackendInputError, BackendUnavailableError, normalize_language
else:  # Support the Electron launcher executing this file directly.
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from native.python.voice_runtime.backend_registry import BackendRegistry
    from native.python.voice_runtime.backends.base import (
        BackendExecutionError,
        BackendInputError,
        BackendUnavailableError,
        normalize_language,
    )

PROTOCOL_VERSION = 1
FAKE = os.environ.get("VOICE_RUNTIME_FAKE") == "1"
DEBUG = os.environ.get("VOICE_RUNTIME_DEBUG") == "1"

try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

_RUNTIME_TEMP = os.environ.get("VOICE_RUNTIME_TEMP_DIR")
if not _RUNTIME_TEMP and not FAKE:
    raise RuntimeError("VOICE_RUNTIME_TEMP_DIR_REQUIRED")
ALLOWED_AUDIO_ROOT = Path(_RUNTIME_TEMP or tempfile.gettempdir()).resolve()


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def runtime_platform() -> str:
    return {
        "darwin": "darwin",
        "linux": "linux",
        "win32": "windows",
    }.get(sys.platform, sys.platform or "unknown")


def runtime_arch() -> str:
    machine = platform.machine().lower()
    return {
        "aarch64": "arm64",
        "amd64": "x64",
        "x86_64": "x64",
    }.get(machine, machine or "unknown")


def create_backend_registry(
    platform_name: str | None = None,
    arch_name: str | None = None,
    *,
    availability: dict[str, bool] | None = None,
    fake: bool | None = None,
) -> BackendRegistry:
    return BackendRegistry(
        platform_name=platform_name or runtime_platform(),
        arch_name=arch_name or runtime_arch(),
        availability=availability,
        fake=FAKE if fake is None else fake,
    )


backend_registry = create_backend_registry()


def health_capabilities(
    platform_name: str | None = None,
    arch_name: str | None = None,
    *,
    availability: dict[str, bool] | None = None,
    registry: BackendRegistry | None = None,
) -> dict[str, Any]:
    selected_registry = registry
    if selected_registry is None:
        if platform_name is not None or arch_name is not None or availability is not None:
            selected_registry = create_backend_registry(
                platform_name,
                arch_name,
                availability=availability,
            )
        else:
            selected_registry = backend_registry
    capabilities = selected_registry.capabilities()
    selected_stt = capabilities["selectedStt"]
    selected_tts = capabilities["selectedTts"]
    legacy_capabilities = []
    if selected_stt:
        legacy_capabilities.append(f"stt.{selected_stt}")
    if selected_tts:
        legacy_capabilities.append("tts.kokoro" if selected_tts.startswith("kokoro-") else f"tts.{selected_tts}")
    if selected_stt == "mlx-whisper":
        whisper_model = (
            os.environ.get("VOICE_MLX_WHISPER_MODEL")
            or os.environ.get("VOICE_WHISPER_MODEL")
            or "mlx-community/whisper-large-v3-turbo"
        )
    elif selected_stt == "faster-whisper":
        whisper_model = os.environ.get("VOICE_FASTER_WHISPER_MODEL", "base.en")
    else:
        whisper_model = "fake" if selected_stt == "fake" else ""
    return {
        "protocol": PROTOCOL_VERSION,
        "fake": selected_registry.fake,
        "platform": selected_registry.platform_name,
        "arch": selected_registry.arch_name,
        **capabilities,
        "capabilities": legacy_capabilities,
        "whisperModel": whisper_model,
    }


def _params_object(params: Any) -> dict[str, Any]:
    if not isinstance(params, dict):
        raise BackendInputError("INVALID_PARAMS")
    return params


def dispatch(method: str, params: Any) -> dict[str, Any]:
    params = _params_object(params)
    if method == "runtime.health":
        return health_capabilities()
    if method == "tts.synthesize":
        text = params.get("text", "")
        voice = params.get("voice", "af_heart")
        speed = params.get("speed", 1.0)
        if not isinstance(text, str):
            raise BackendInputError("INVALID_TEXT")
        if not isinstance(voice, str):
            raise BackendInputError("INVALID_VOICE")
        if isinstance(speed, bool) or not isinstance(speed, (int, float)):
            raise BackendInputError("INVALID_SPEED")
        return backend_registry.synthesize(
            text,
            voice,
            float(speed),
        )
    if method == "stt.transcribe":
        audio_path = params.get("audioPath", "")
        language = params.get("language", "en")
        if not isinstance(audio_path, str) or not audio_path:
            raise BackendInputError("INVALID_AUDIO_PATH")
        if not isinstance(language, str):
            raise BackendInputError("INVALID_LANGUAGE")
        return backend_registry.transcribe(
            audio_path,
            normalize_language(language),
        )
    raise BackendInputError("UNKNOWN_METHOD")


def public_error_payload(error: Exception) -> dict[str, str]:
    if isinstance(error, (BackendInputError, BackendUnavailableError, BackendExecutionError)):
        message = str(error)
        return {"code": message.split(":", 1)[0], "message": message}
    if isinstance(error, json.JSONDecodeError):
        return {"code": "INVALID_JSON", "message": "INVALID_JSON"}
    return {"code": "INTERNAL_ERROR", "message": "INTERNAL_ERROR"}


def serve() -> None:
    emit({"event": "ready", "protocol": PROTOCOL_VERSION})
    for raw_line in sys.stdin:
        request_id = None
        try:
            request = json.loads(raw_line)
            if not isinstance(request, dict):
                raise BackendInputError("INVALID_REQUEST")
            candidate_id = request.get("id")
            if not isinstance(candidate_id, str) or not candidate_id:
                raise BackendInputError("MISSING_REQUEST_ID")
            request_id = candidate_id
            method = request.get("method")
            if not isinstance(method, str):
                raise BackendInputError("INVALID_METHOD")
            log(f"REQUEST_STARTED:{request_id}:{method}")
            result = dispatch(method, request.get("params", {}))
            emit({"id": request_id, "success": True, "result": result})
        except Exception as error:
            public_error = public_error_payload(error)
            log(traceback.format_exc() if DEBUG else public_error["code"])
            emit({
                "id": request_id,
                "success": False,
                "error": public_error,
            })


if __name__ == "__main__":
    serve()
