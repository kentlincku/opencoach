"""Dependency-free backends for contract tests and CI."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .base import STTBackend, TTSBackend, normalize_language, samples_to_wav, validate_audio_path, validate_tts_input


class FakeSTTBackend(STTBackend):
    def __init__(self, allowed_audio_root: Path) -> None:
        self.allowed_audio_root = allowed_audio_root.resolve()

    def transcribe(self, audio_path: str, language: str = "en") -> dict[str, Any]:
        validate_audio_path(audio_path, self.allowed_audio_root, require_file=False)
        language = normalize_language(language)
        return {
            "text": "Fake transcription",
            "language": language,
            "model": "fake",
            "engine": "fake",
        }


class FakeTTSBackend(TTSBackend):
    def synthesize(self, text: str, voice: str, speed: float) -> dict[str, Any]:
        validate_tts_input(text, voice, speed)
        return {**samples_to_wav([0.0] * 1200), "engine": "fake"}
