"""Lazy, reusable backend selection for the persistent voice sidecar."""
from __future__ import annotations

import importlib.util
import os
import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .backends.base import (
    BackendExecutionError,
    BackendInputError,
    BackendUnavailableError,
    STTBackend,
    TTSBackend,
)

STT_IDS = ("mlx-whisper", "faster-whisper")
TTS_IDS = ("kokoro-python", "kokoro-onnx")
STT_ALIASES = {"mlx": "mlx-whisper", "mlx-whisper": "mlx-whisper", "faster-whisper": "faster-whisper"}
TTS_ALIASES = {"kokoro-python": "kokoro-python", "kokoro-onnx": "kokoro-onnx"}


def _module_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, AttributeError, ValueError):
        return False


def _local_asset_available(variable: str) -> bool:
    value = os.environ.get(variable)
    return bool(value and Path(value).exists())


def _offline_requested() -> bool:
    return os.environ.get("HF_HUB_OFFLINE") == "1" or os.environ.get("TRANSFORMERS_OFFLINE") == "1"


def detect_availability() -> dict[str, bool]:
    """Check import metadata and required local assets; never initialize a model."""
    offline = _offline_requested()
    onnx_model = os.environ.get("VOICE_KOKORO_ONNX_MODEL")
    onnx_voices = os.environ.get("VOICE_KOKORO_ONNX_VOICES")
    onnx_assets_ready = bool(
        onnx_model and onnx_voices
        and Path(onnx_model).is_file()
        and Path(onnx_voices).is_file()
    )
    return {
        "mlx-whisper": _module_available("mlx_whisper") and (
            not offline or _local_asset_available("VOICE_MLX_WHISPER_MODEL")
        ),
        "faster-whisper": _module_available("faster_whisper") and (
            not offline or _local_asset_available("VOICE_FASTER_WHISPER_MODEL")
        ),
        "kokoro-python": _module_available("kokoro") and _module_available("numpy") and (
            not offline or _local_asset_available("VOICE_KOKORO_MODEL")
        ),
        "kokoro-onnx": (
            _module_available("kokoro_onnx")
            and _module_available("numpy")
            and onnx_assets_ready
        ),
    }


def _default_factories() -> dict[str, Callable[[], Any]]:
    def mlx():
        from .backends.mlx_whisper import MLXWhisperBackend
        return MLXWhisperBackend()

    def faster():
        from .backends.faster_whisper import FasterWhisperBackend
        return FasterWhisperBackend()

    def kokoro_python():
        from .backends.kokoro_python import KokoroPythonBackend
        return KokoroPythonBackend()

    def kokoro_onnx():
        from .backends.kokoro_onnx import KokoroOnnxBackend
        return KokoroOnnxBackend()

    def fake_stt():
        from .backends.fake import FakeSTTBackend
        return FakeSTTBackend(Path(os.environ.get("VOICE_RUNTIME_TEMP_DIR") or tempfile.gettempdir()))

    def fake_tts():
        from .backends.fake import FakeTTSBackend
        return FakeTTSBackend()

    return {
        "mlx-whisper": mlx,
        "faster-whisper": faster,
        "kokoro-python": kokoro_python,
        "kokoro-onnx": kokoro_onnx,
        "fake-stt": fake_stt,
        "fake-tts": fake_tts,
    }


class BackendRegistry:
    def __init__(
        self,
        *,
        platform_name: str,
        arch_name: str,
        stt_choice: str | None = None,
        tts_choice: str | None = None,
        availability: Mapping[str, bool] | None = None,
        factories: Mapping[str, Callable[[], Any]] | None = None,
        fake: bool = False,
    ) -> None:
        self.platform_name = platform_name
        self.arch_name = arch_name
        self.fake = fake
        self.stt_choice = "fake" if fake else (stt_choice or os.environ.get("VOICE_STT_BACKEND", "auto"))
        self.tts_choice = "fake" if fake else (tts_choice or os.environ.get("VOICE_TTS_BACKEND", "auto"))
        self._availability = dict(availability if availability is not None else detect_availability())
        self._factories = {**_default_factories(), **dict(factories or {})}
        self.selected_stt = "fake" if fake else self._select_stt(self.stt_choice)
        self.selected_tts = "fake" if fake else self._select_tts(self.tts_choice)
        self._stt: STTBackend | Any | None = None
        self._tts: TTSBackend | Any | None = None
        self._stt_failure: RuntimeError | None = None
        self._tts_failure: RuntimeError | None = None

    def _is_compatible(self, backend_id: str) -> bool:
        if backend_id == "mlx-whisper":
            return self.platform_name == "darwin" and self.arch_name == "arm64"
        return True

    def _select_stt(self, choice: str) -> str | None:
        if choice == "auto":
            candidates = ["mlx-whisper", "faster-whisper"] if (
                self.platform_name == "darwin" and self.arch_name == "arm64"
            ) else ["faster-whisper"]
            return next((item for item in candidates if self._availability.get(item, False)), None)
        backend_id = STT_ALIASES.get(choice)
        return backend_id if (
            backend_id
            and self._is_compatible(backend_id)
            and self._availability.get(backend_id, False)
        ) else None

    def _select_tts(self, choice: str) -> str | None:
        if choice == "auto":
            candidates = list(TTS_IDS) if (
                self.platform_name == "darwin" and self.arch_name == "arm64"
            ) else ["kokoro-onnx", "kokoro-python"]
            return next((item for item in candidates if self._availability.get(item, False)), None)
        backend_id = TTS_ALIASES.get(choice)
        return backend_id if backend_id and self._availability.get(backend_id, False) else None

    def capabilities(self) -> dict[str, Any]:
        if self.fake:
            return {
                "sttBackends": ["fake"],
                "ttsBackends": ["fake"],
                "selectedStt": "fake",
                "selectedTts": "fake",
                "ready": True,
                "degradedReason": None,
            }
        available_stt = [
            item for item in STT_IDS
            if self._is_compatible(item) and self._availability.get(item, False)
        ]
        available_tts = [
            item for item in TTS_IDS
            if self._is_compatible(item) and self._availability.get(item, False)
        ]
        ready = self.selected_stt is not None and self.selected_tts is not None
        tts_provider = None
        if self.selected_tts == "kokoro-onnx":
            if self._tts is not None and hasattr(self._tts, "execution_provider"):
                tts_provider = self._tts.execution_provider
        return {
            "sttBackends": available_stt,
            "ttsBackends": available_tts,
            "selectedStt": self.selected_stt,
            "selectedTts": self.selected_tts,
            "executionProvider": tts_provider,
            "ready": ready,
            "degradedReason": None if ready else "BACKEND_UNAVAILABLE",
        }

    def _get_stt(self):
        if self._stt_failure is not None:
            raise self._stt_failure
        if self.selected_stt is None:
            raise BackendUnavailableError("stt", None)
        if self._stt is None:
            try:
                factory_id = "fake-stt" if self.selected_stt == "fake" else self.selected_stt
                self._stt = self._factories[factory_id]()
            except Exception as error:
                public_error = BackendUnavailableError("stt", self.selected_stt, "initialization failed")
                if self.selected_stt:
                    self._availability[self.selected_stt] = False
                self.selected_stt = None
                self._stt_failure = public_error
                raise public_error from error
        return self._stt

    def _get_tts(self):
        if self._tts_failure is not None:
            raise self._tts_failure
        if self.selected_tts is None:
            raise BackendUnavailableError("tts", None)
        if self._tts is None:
            try:
                factory_id = "fake-tts" if self.selected_tts == "fake" else self.selected_tts
                self._tts = self._factories[factory_id]()
            except Exception as error:
                public_error = BackendUnavailableError("tts", self.selected_tts, "initialization failed")
                if self.selected_tts:
                    self._availability[self.selected_tts] = False
                self.selected_tts = None
                self._tts_failure = public_error
                raise public_error from error
        return self._tts

    def transcribe(self, audio_path: str, language: str = "en") -> dict[str, Any]:
        backend_id = self.selected_stt or "none"
        backend = self._get_stt()
        try:
            return backend.transcribe(audio_path, language)
        except BackendInputError:
            raise
        except BackendUnavailableError as error:
            public_error = BackendUnavailableError("stt", backend_id, "runtime unavailable")
            self._availability[backend_id] = False
            self.selected_stt = None
            self._stt_failure = public_error
            raise public_error from error
        except Exception as error:
            public_error = BackendExecutionError("stt", backend_id)
            self._availability[backend_id] = False
            self.selected_stt = None
            self._stt_failure = public_error
            raise public_error from error

    def synthesize(self, text: str, voice: str, speed: float) -> dict[str, Any]:
        backend_id = self.selected_tts or "none"
        backend = self._get_tts()
        try:
            return backend.synthesize(text, voice, speed)
        except BackendInputError:
            raise
        except BackendUnavailableError as error:
            public_error = BackendUnavailableError("tts", backend_id, "runtime unavailable")
            self._availability[backend_id] = False
            self.selected_tts = None
            self._tts_failure = public_error
            raise public_error from error
        except Exception as error:
            public_error = BackendExecutionError("tts", backend_id)
            self._availability[backend_id] = False
            self.selected_tts = None
            self._tts_failure = public_error
            raise public_error from error

    def cancel(self) -> None:
        for backend in (self._stt, self._tts):
            if backend is not None and callable(getattr(backend, "cancel", None)):
                backend.cancel()
