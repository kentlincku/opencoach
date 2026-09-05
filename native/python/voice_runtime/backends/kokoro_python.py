"""Kokoro Python TTS backend used by the existing Apple Silicon runtime."""
from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from ..text import clean_text_for_speech
from .base import BackendUnavailableError, TTSBackend, samples_to_wav, validate_tts_input


class KokoroPythonBackend(TTSBackend):
    def __init__(self, *, pipeline_factory: Callable[[], Any] | None = None) -> None:
        self._pipeline_factory = pipeline_factory
        self._pipeline = None

    def _get_pipeline(self):
        if self._pipeline is None:
            if self._pipeline_factory is None:
                try:
                    try:
                        import spacy
                        import spacy.util
                        orig_is_pkg = spacy.util.is_package
                        spacy.util.is_package = lambda name: True if name == "en_core_web_sm" else orig_is_pkg(name)
                        orig_load = spacy.load
                        def _safe_spacy_load(name, **kwargs):
                            if name == "en_core_web_sm":
                                import en_core_web_sm
                                return en_core_web_sm.load(**kwargs)
                            return orig_load(name, **kwargs)
                        spacy.load = _safe_spacy_load
                    except Exception:
                        pass
                    import kokoro
                except ImportError as error:
                    raise BackendUnavailableError("tts", "kokoro-python", "dependency missing") from error
                repository = os.environ.get("VOICE_KOKORO_MODEL", "hexgrad/Kokoro-82M")
                self._pipeline_factory = lambda: kokoro.KPipeline(
                    lang_code="a",
                    repo_id=repository,
                )
            self._pipeline = self._pipeline_factory()
        return self._pipeline

    def synthesize(self, text: str, voice: str, speed: float) -> dict[str, Any]:
        cleaned = clean_text_for_speech(text)
        validate_tts_input(cleaned, voice, speed)
        samples: list[float] = []
        for _, _, audio in self._get_pipeline()(cleaned, voice=voice, speed=speed):
            if hasattr(audio, "cpu"):
                audio = audio.cpu().numpy()
            if hasattr(audio, "flatten"):
                audio = audio.flatten()
            if hasattr(audio, "tolist"):
                audio = audio.tolist()
            samples.extend(float(value) for value in audio)
        if not samples:
            raise RuntimeError("NO_AUDIO_GENERATED")
        return {**samples_to_wav(samples), "engine": "kokoro-python"}
