"""Decode runtime PCM WAV input without a media-decoder fallback."""
import struct
from pathlib import Path

from .backends.base import BackendInputError

# Same byte ceiling as Desktop IPC, enforced independently for runtime callers.
MAX_WAV_BYTES = 25 * 1024 * 1024


def decode_wav(path: Path):
    """Return 1-D float32 16 kHz PCM; caller must authorize the resolved path.

    Supports format-tag 1, 16-bit mono/stereo only (not WAVE_FORMAT_EXTENSIBLE).
    RIFF size, every chunk and padding byte must fit the complete bounded file.
    Unknown chunks are skipped, not decoded; no resampling or codec fallback.
    """
    with path.open("rb") as stream:
        raw = stream.read(MAX_WAV_BYTES + 1)
    if len(raw) > MAX_WAV_BYTES:
        raise BackendInputError("AUDIO_PAYLOAD_TOO_LARGE")
    if (len(raw) < 12 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE"
            or struct.unpack_from("<I", raw, 4)[0] != len(raw) - 8):
        raise BackendInputError("INVALID_WAV")

    offset = 12
    channels = None
    pcm = None
    while offset < len(raw):
        if len(raw) - offset < 8:
            raise BackendInputError("INVALID_WAV")
        tag = raw[offset:offset + 4]
        size = struct.unpack_from("<I", raw, offset + 4)[0]
        start = offset + 8
        end = start + size
        offset = end + (size % 2)
        if offset > len(raw):
            raise BackendInputError("INVALID_WAV")
        if tag == b"fmt ":
            if channels is not None or size < 16:
                raise BackendInputError("INVALID_WAV")
            encoding, channels, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", raw, start)
            if (encoding != 1 or channels not in (1, 2) or rate != 16000 or bits != 16
                    or align != channels * 2 or byte_rate != rate * align
                    or size not in (16, 18)
                    or (size == 18 and raw[start + 16:end] != b"\0\0")):
                raise BackendInputError("UNSUPPORTED_WAV_FORMAT")
        elif tag == b"data":
            if channels is None or pcm is not None:
                raise BackendInputError("INVALID_WAV")
            pcm = memoryview(raw)[start:end]
    if channels is None or pcm is None or not pcm or len(pcm) % (channels * 2):
        raise BackendInputError("INVALID_WAV")

    import numpy as np

    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / np.float32(32768)
    if channels == 2:
        samples = samples.reshape(-1, 2).mean(axis=1, dtype=np.float32)
    return samples
