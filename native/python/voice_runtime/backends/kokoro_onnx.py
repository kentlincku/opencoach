"""Cross-platform Kokoro ONNX TTS backend.

The model and voice asset paths are supplied by setup/runtime-manager work. This
module deliberately does not download assets or import ONNX code at startup.
"""
from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..text import clean_text_for_speech
from .base import (
    BackendExecutionError,
    BackendInputError,
    BackendUnavailableError,
    TTSBackend,
    samples_to_wav,
    validate_tts_input,
)


class KokoroOnnxBackend(TTSBackend):
    def __init__(
        self,
        *,
        model_path: Path | None = None,
        voices_path: Path | None = None,
        requested_provider: str | None = None,
        engine_factory: Callable[[str, str], Any] | None = None,
    ) -> None:
        model_value = model_path or (
            Path(os.environ["VOICE_KOKORO_ONNX_MODEL"])
            if os.environ.get("VOICE_KOKORO_ONNX_MODEL") else None
        )
        voices_value = voices_path or (
            Path(os.environ["VOICE_KOKORO_ONNX_VOICES"])
            if os.environ.get("VOICE_KOKORO_ONNX_VOICES") else None
        )
        if model_value is None or voices_value is None:
            raise BackendUnavailableError("tts", "kokoro-onnx", "model assets not configured")
        self.model_path = model_value.resolve()
        self.voices_path = voices_value.resolve()
        if not self.model_path.is_file() or not self.voices_path.is_file():
            raise BackendUnavailableError("tts", "kokoro-onnx", "model assets missing")
        self.requested_provider = (
            requested_provider or os.environ.get("VOICE_KOKORO_EXECUTION_PROVIDER", "cpu")
        ).lower()
        self._engine_factory = engine_factory
        self._engine = None

    @property
    def execution_provider(self) -> str:
        engine = self._get_engine()
        sess = getattr(engine, "sess", None)
        providers = sess.get_providers() if sess and hasattr(sess, "get_providers") else ["CPUExecutionProvider"]
        if self.requested_provider in ("directml", "dmlexecutionprovider"):
            if "DmlExecutionProvider" not in providers:
                raise BackendUnavailableError("tts", "kokoro-onnx", "DirectML provider unavailable")
            return "DmlExecutionProvider"
        if "DmlExecutionProvider" in providers:
            return "DmlExecutionProvider"
        return "CPUExecutionProvider"

    def _get_engine(self):
        if self._engine is None:
            if self._engine_factory is None:
                try:
                    from kokoro_onnx import Kokoro
                except ImportError as error:
                    raise BackendUnavailableError("tts", "kokoro-onnx", "dependency missing") from error

                def default_factory(model_str: str, voices_str: str):
                    try:
                        import onnxruntime as ort
                        target_providers = (
                            ["DmlExecutionProvider", "CPUExecutionProvider"]
                            if self.requested_provider in ("directml", "dmlexecutionprovider")
                            else ["CPUExecutionProvider"]
                        )
                        session = ort.InferenceSession(model_str, providers=target_providers)
                        k = Kokoro(model_str, voices_str)
                        k.sess = session
                        return k
                    except Exception as err:
                        raise BackendUnavailableError("tts", "kokoro-onnx", f"engine creation failed: {err}") from err

                self._engine_factory = default_factory
            self._engine = self._engine_factory(str(self.model_path), str(self.voices_path))
            # Validate provider boundary
            _ = self.execution_provider
        return self._engine

    def synthesize(self, text: str, voice: str, speed: float) -> dict[str, Any]:
        cleaned = clean_text_for_speech(text)
        validate_tts_input(cleaned, voice, speed)
        prov = self.execution_provider
        try:
            samples, sample_rate = self._get_engine().create(
                cleaned,
                voice=voice,
                speed=speed,
                lang="en-us",
            )
        except Exception as error:
            if isinstance(error, (BackendInputError, BackendUnavailableError)):
                raise
            raise BackendExecutionError("tts", "kokoro-onnx") from error

        result = samples_to_wav(samples, int(sample_rate))
        return {
            **result,
            "engine": "kokoro-onnx",
            "executionProvider": prov,
        }
