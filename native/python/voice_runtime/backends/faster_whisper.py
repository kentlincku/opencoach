"""Cross-platform faster-whisper STT backend."""
from __future__ import annotations

import os
import sys
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .base import (
    BackendExecutionError, BackendInputError, BackendUnavailableError, STTBackend,
    normalize_language, validate_audio_path,
)
from ..wav_decoder import decode_wav

DEFAULT_MODEL = "base.en"
WINDOWS_CPU_THREADS = 4


class FasterWhisperBackend(STTBackend):
    def __init__(
        self,
        *,
        model_id: str | None = None,
        allowed_audio_root: Path | None = None,
        model_factory: Callable[..., Any] | None = None,
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
        # Explicit device/compute_type (argument or env) win; otherwise the
        # accelerator policy picks CUDA (float16) first and falls back to CPU (int8).
        self.device = device or os.environ.get("VOICE_FASTER_WHISPER_DEVICE") or None
        self.compute_type = compute_type or os.environ.get("VOICE_FASTER_WHISPER_COMPUTE_TYPE") or None
        self._model_factory = model_factory
        self._model = None
        self.placement = None

    def _plan(self):
        import sys
        # An explicit device (argument or VOICE_FASTER_WHISPER_DEVICE) is passed
        # through unchanged with no fallback -- including "auto", which hands the
        # choice to ctranslate2. On Windows ctranslate2 "auto" may pick CUDA and
        # abort the process on a missing cuDNN DLL; leave the device unset to get
        # the accelerator policy's DLL preload and CPU fallback instead.
        if self.device is not None:
            return [(self.device, self.compute_type or "int8")]
        from .. import accelerator
        # Non-Windows keeps the historical ("auto", int8) placement unchanged.
        cpu = ("cpu" if sys.platform == "win32" else "auto", self.compute_type or "int8")
        if accelerator.use_cuda("stt"):
            cuda = ("cuda", self.compute_type or "float16")
            return [cuda] if accelerator.policy() == "cuda" else [cuda, cpu]
        return [cpu]

    def _cuda_required(self):
        from .. import accelerator
        return accelerator.policy() == "cuda"

    def _get_model(self):
        if self._model is None:
            kwargs: dict[str, Any] = {}
            if (os.environ.get("HF_HUB_OFFLINE") == "1"
                    or os.environ.get("TRANSFORMERS_OFFLINE") == "1"):
                model_path = Path(self.model_id)
                if not model_path.is_absolute() or not model_path.is_dir():
                    raise BackendUnavailableError("stt", "faster-whisper", "local model required")
                if not (model_path / "tokenizer.json").is_file():
                    raise BackendUnavailableError("stt", "faster-whisper", "local tokenizer required")
                kwargs["local_files_only"] = True
            if self._model_factory is None:
                try:
                    from voice_practice_speech_vendor.faster_whisper import WhisperModel
                except ImportError as error:
                    raise BackendUnavailableError("stt", "faster-whisper", "dependency missing") from error
                self._model_factory = WhisperModel
            plan = self._plan()
            for index, (device, compute_type) in enumerate(plan):
                placement_kwargs = dict(kwargs)
                # Windows CPU: fixed 4 threads. Measured on a hybrid P/E-core CPU,
                # 8 threads was not faster than 4 (2026-10-08 maintainer benchmark).
                if device == "cpu" and sys.platform == "win32":
                    placement_kwargs["cpu_threads"] = WINDOWS_CPU_THREADS
                try:
                    self._model = self._model_factory(
                        self.model_id, device=device, compute_type=compute_type, **placement_kwargs)
                except (RuntimeError, ValueError, OSError) as error:
                    if index == len(plan) - 1:
                        if device == "cuda" and self._cuda_required():
                            raise BackendUnavailableError(
                                "stt", "faster-whisper", "CUDA_REQUIRED:CUDA_LOAD_FAILED") from error
                        raise
                    continue
                self.placement = (device, compute_type)
                break
        return self._model

    def transcribe(self, audio_path: str, language: str = "en") -> dict[str, Any]:
        path = validate_audio_path(audio_path, self.allowed_audio_root)
        language = normalize_language(language)
        audio = decode_wav(path)
        model = self._get_model()
        supported_languages = model.supported_languages
        if (not isinstance(supported_languages, (list, tuple)) or not supported_languages
                or any(not isinstance(code, str) or not re.fullmatch(r"[a-z]{2,3}", code)
                       for code in supported_languages)):
            raise BackendExecutionError("stt", "faster-whisper")
        if language not in supported_languages:
            raise BackendInputError("UNSUPPORTED_LANGUAGE_FOR_MODEL")
        segments, _ = model.transcribe(
            audio,
            language=language,
            condition_on_previous_text=False,
            vad_filter=True,
        )
        text = " ".join(
            part for segment in segments
            if (part := str(getattr(segment, "text", "")).strip())
        )
        return {
            "text": text,
            "language": language,
            "model": self.model_id,
            "engine": "faster-whisper",
        }
