"""Cross-platform faster-whisper STT backend."""
from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .base import BackendInputError, BackendUnavailableError, STTBackend, normalize_language, validate_audio_path

DEFAULT_MODEL = "base.en"


class FasterWhisperBackend(STTBackend):
    def __init__(
        self,
        *,
        model_id: str | None = None,
        allowed_audio_root: Path | None = None,
        model_factory: Callable[..., Any] | None = None,
        audio_decoder: Callable[..., Any] | None = None,
        device: str | None = None,
        compute_type: str | None = None,
    ) -> None:
        root = allowed_audio_root or (
            Path(os.environ["VOICE_RUNTIME_TEMP_DIR"])
            if os.environ.get("VOICE_RUNTIME_TEMP_DIR") else None
        )
        if root is None:
            raise BackendUnavailableError("stt", "faster-whisper", "VOICE_RUNTIME_TEMP_DIR_REQUIRED")
        self.model_id = model_id or os.environ.get("VOICE_FASTER_WHISPER_MODEL", DEFAULT_MODEL)
        self.allowed_audio_root = root.resolve()
        self.device = device or os.environ.get("VOICE_FASTER_WHISPER_DEVICE", "auto")
        self.compute_type = compute_type or os.environ.get("VOICE_FASTER_WHISPER_COMPUTE_TYPE", "int8")
        self._model_factory = model_factory
        self._audio_decoder = audio_decoder
        self._model = None

    def _create_model(self, device: str):
        if self._model_factory is None:
            try:
                from faster_whisper import WhisperModel
            except ImportError as error:
                raise BackendUnavailableError("stt", "faster-whisper", "dependency missing") from error
            self._model_factory = WhisperModel
        return self._model_factory(
            self.model_id,
            device=device,
            compute_type=self.compute_type,
        )

    def _get_model(self):
        if self._model is None:
            try:
                self._model = self._create_model(self.device)
            except Exception as err:
                if self.device == "auto" and any(k in str(err).lower() for k in ("cublas", "cuda", "cudnn")):
                    self.device = "cpu"
                    self._model = self._create_model("cpu")
                else:
                    raise
        return self._model

    def transcribe(self, audio_path: str, language: str = "en") -> dict[str, Any]:
        language = normalize_language(language)
        if self.model_id.lower().endswith(".en") and language != "en":
            raise BackendInputError("UNSUPPORTED_LANGUAGE_FOR_MODEL")

        if self._audio_decoder is not None:
            samples = self._audio_decoder(audio_path, self.allowed_audio_root)
        else:
            from ..wav_decoder import read_pcm_wav
            samples = read_pcm_wav(audio_path, self.allowed_audio_root)

        def run_transcription() -> str:
            segments, _ = self._get_model().transcribe(
                samples,
                language=language,
                condition_on_previous_text=False,
                vad_filter=True,
            )
            return " ".join(
                part for segment in segments
                if (part := str(getattr(segment, "text", "")).strip())
            )

        try:
            text = run_transcription()
        except Exception as err:
            if self.device == "auto" and any(k in str(err).lower() for k in ("cublas", "cuda", "cudnn")):
                self.device = "cpu"
                self._model = self._create_model("cpu")
                text = run_transcription()
            else:
                raise

        return {
            "text": text,
            "language": language,
            "model": self.model_id,
            "engine": "faster-whisper",
        }
