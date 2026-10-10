"""Apple Silicon MLX Whisper STT backend."""
from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .base import BackendUnavailableError, STTBackend, normalize_language, validate_audio_path

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


class MLXWhisperBackend(STTBackend):
    def __init__(
        self,
        *,
        model_id: str | None = None,
        allowed_audio_root: Path | None = None,
        transcriber: Callable[..., dict[str, Any]] | None = None,
    ) -> None:
        root = allowed_audio_root or (
            Path(os.environ["VOICE_RUNTIME_TEMP_DIR"])
            if os.environ.get("VOICE_RUNTIME_TEMP_DIR") else None
        )
        if root is None:
            raise BackendUnavailableError("stt", "mlx-whisper", "VOICE_RUNTIME_TEMP_DIR_REQUIRED")
        self.model_id = (
            model_id
            or os.environ.get("VOICE_MLX_WHISPER_MODEL")
            or os.environ.get("VOICE_WHISPER_MODEL")
            or DEFAULT_MODEL
        )
        self.allowed_audio_root = root.resolve()
        self._transcriber = transcriber

    def _get_transcriber(self):
        if self._transcriber is None:
            try:
                import mlx_whisper
            except ImportError as error:
                raise BackendUnavailableError("stt", "mlx-whisper", "dependency missing") from error
            self._transcriber = mlx_whisper.transcribe
        return self._transcriber

    def _local_model_path(self) -> Path:
        try:
            model = Path(self.model_id)
            if not model.is_absolute() or not model.is_dir():
                raise ValueError("local directory required")
            model = model.resolve(strict=True)
            # Bounded layout admission only, not model validity or hash binding.
            # Reject symlinks/special files without opening potentially huge weights.
            import stat

            config = (model / "config.json").lstat()
            if not stat.S_ISREG(config.st_mode) or config.st_size == 0:
                raise ValueError("local configuration required")
            # Match upstream load_models.py precedence; an invalid preferred file
            # must not be bypassed in favour of a lower-priority weight file.
            for name in ("model.safetensors", "weights.safetensors", "weights.npz"):
                try:
                    weights = (model / name).lstat()
                except FileNotFoundError:
                    continue
                if not stat.S_ISREG(weights.st_mode) or weights.st_size == 0:
                    raise ValueError("local weights required")
                return model
            raise ValueError("local weights required")
        except (OSError, ValueError, RuntimeError):
            raise BackendUnavailableError("stt", "mlx-whisper", "LOCAL_MODEL_REQUIRED") from None

    def transcribe(self, audio_path: str, language: str = "en") -> dict[str, Any]:
        path = validate_audio_path(audio_path, self.allowed_audio_root)
        language = normalize_language(language)
        model = self._local_model_path()
        from ..wav_decoder import decode_wav

        samples = decode_wav(path)
        result = self._get_transcriber()(
            samples,
            path_or_hf_repo=str(model),
            language=language,
            condition_on_previous_text=False,
            temperature=0.0,
        )
        return {
            "text": str(result.get("text", "")).strip(),
            "language": language,
            "model": self.model_id,
            "engine": "mlx-whisper",
        }
