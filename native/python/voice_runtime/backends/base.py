"""Minimal interfaces and shared errors for voice runtime backends."""
from __future__ import annotations

from abc import ABC, abstractmethod
import base64
import math
import re
import struct
import wave
from io import BytesIO
from pathlib import Path
from typing import Any


class BackendInputError(ValueError):
    """A fixed, safe validation code that may cross the JSONL boundary."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


WHISPER_LANGUAGE_CODES = frozenset(
    "en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs "
    "ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk "
    "br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu "
    "am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su".split()
)


def validate_audio_path(raw_path: str, allowed_audio_root: Path, *, require_file: bool = True) -> Path:
    if not raw_path or len(raw_path) > 4096:
        raise BackendInputError("INVALID_AUDIO_PATH")
    try:
        path = Path(raw_path).resolve()
        root = allowed_audio_root.resolve()
    except (OSError, ValueError) as error:
        raise BackendInputError("INVALID_AUDIO_PATH") from error
    if root != path and root not in path.parents:
        raise BackendInputError("AUDIO_PATH_OUTSIDE_RUNTIME_TEMP")
    if require_file and not path.is_file():
        raise BackendInputError("AUDIO_FILE_NOT_FOUND")
    return path


def normalize_language(language: str) -> str:
    if not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?", language):
        raise BackendInputError("INVALID_LANGUAGE")
    normalized = language.split("-", 1)[0].lower()
    if normalized not in WHISPER_LANGUAGE_CODES:
        raise BackendInputError("INVALID_LANGUAGE")
    return normalized


def validate_tts_input(text: str, voice: str, speed: float) -> None:
    if not text.strip():
        raise BackendInputError("EMPTY_TEXT")
    if len(text) > 5000:
        raise BackendInputError("INVALID_TEXT_LENGTH")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", voice):
        raise BackendInputError("INVALID_VOICE")
    if not math.isfinite(speed) or not 0.5 <= speed <= 2.0:
        raise BackendInputError("INVALID_SPEED")


def samples_to_wav(samples: Any, sample_rate: int = 24000) -> dict[str, Any]:
    if hasattr(samples, "cpu"):
        samples = samples.cpu().numpy()
    if hasattr(samples, "flatten"):
        samples = samples.flatten()
    if hasattr(samples, "tolist"):
        samples = samples.tolist()
    values = [max(-1.0, min(1.0, float(value))) for value in samples]
    if not values:
        raise RuntimeError("NO_AUDIO_GENERATED")
    pcm = struct.pack("<" + "h" * len(values), *(int(value * 32767) for value in values))
    buffer = BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return {
        "audio": base64.b64encode(buffer.getvalue()).decode("ascii"),
        "format": "audio/wav",
        "sampleRate": sample_rate,
    }


class BackendUnavailableError(RuntimeError):
    """Raised when the configured backend cannot be selected or loaded."""

    def __init__(self, kind: str, backend_id: str | None, reason: str = "not available") -> None:
        self.kind = kind
        self.backend_id = backend_id
        super().__init__(f"BACKEND_UNAVAILABLE:{kind}:{backend_id or 'none'}:{reason}")


class BackendExecutionError(RuntimeError):
    """Stable public error that does not expose dependency or host details."""

    def __init__(self, kind: str, backend_id: str) -> None:
        super().__init__(f"BACKEND_ERROR:{kind}:{backend_id}")


class STTBackend(ABC):
    @abstractmethod
    def transcribe(self, audio_path: str, language: str = "en") -> dict[str, Any]:
        raise NotImplementedError

    def cancel(self) -> None:
        """Best-effort cancellation hook; late results are invalidated by callers."""


class TTSBackend(ABC):
    @abstractmethod
    def synthesize(self, text: str, voice: str, speed: float) -> dict[str, Any]:
        raise NotImplementedError

    def cancel(self) -> None:
        """Best-effort cancellation hook; late results are invalidated by callers."""
