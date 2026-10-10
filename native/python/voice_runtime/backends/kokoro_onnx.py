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
from .base import BackendUnavailableError, TTSBackend, samples_to_wav, validate_tts_input


class KokoroOnnxBackend(TTSBackend):
    def __init__(
        self,
        *,
        model_path: Path | None = None,
        voices_path: Path | None = None,
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
        # Preserve the supplied path's association so the lazy fd gate can reject
        # symlinks instead of erasing them through resolve().
        self.model_path = model_value.absolute()
        self.voices_path = voices_value.absolute()
        if not self.model_path.is_file() or not self.voices_path.is_file():
            raise BackendUnavailableError("tts", "kokoro-onnx", "model assets missing")
        self._engine_factory = engine_factory
        self._engine = None
        self._cpu_engine = False
        self._provider_success = False
        self._provider = 'CPUExecutionProvider'

    def provider_evidence(self):
        """Passive, detached historical facts; never initializes or queries a session."""
        success = self._provider_success
        provider = self._provider if success else None
        sessions = {'CPUExecutionProvider': ['CPUExecutionProvider'],
                    'CUDAExecutionProvider': ['CUDAExecutionProvider', 'CPUExecutionProvider']}
        return dict(requested=provider,
                    sessionProviders=list(sessions[provider]) if provider else [],
                    modelLoaded=success, inferenceSucceeded=success,
                    executionProvider=provider)

    def _get_engine(self):
        if self._engine is None:
            if self._engine_factory is None:
                from ..onnx_engine import create_cpu_engine, _CpuEngine
                self._engine = create_cpu_engine(self.model_path, self.voices_path)
                self._cpu_engine = type(self._engine) is _CpuEngine
                if self._cpu_engine:
                    self._provider = self._engine._provider
            else:
                self._engine = self._engine_factory(str(self.model_path), str(self.voices_path))
        return self._engine

    def synthesize(self, text: str, voice: str, speed: float) -> dict[str, Any]:
        from ..english_g2p import speakable
        from .base import BackendInputError, BackendExecutionError
        cleaned = clean_text_for_speech(text)
        validate_tts_input(cleaned, voice, speed)
        # Drop the few spellings the English G2P cannot read instead of failing the reply.
        cleaned = speakable(cleaned)
        try:
            engine = self._get_engine()
            samples, sample_rate = engine.create(cleaned, voice=voice, speed=speed, lang='en-us')
            import math
            from numbers import Real
            if not isinstance(sample_rate, Real) or sample_rate != 24000 or getattr(samples, 'ndim', 1) != 1:
                raise BackendExecutionError('tts', 'kokoro-onnx')
            values = list(samples)
            if not values or any(not isinstance(value, Real) or not math.isfinite(value) for value in values):
                raise BackendExecutionError('tts', 'kokoro-onnx')
            result = samples_to_wav(values, 24000)
            self._provider_success = self._cpu_engine
            return {**result, 'engine': 'kokoro-onnx'}
        except BackendInputError:
            raise
        except BackendUnavailableError:
            self._provider_success = False
            raise
        except Exception:
            self._provider_success = False
            raise BackendExecutionError('tts', 'kokoro-onnx') from None
