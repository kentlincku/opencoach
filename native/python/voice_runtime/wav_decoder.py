"""RIFF PCM WAV decoder strictly validating 16-bit 16kHz mono/stereo WAV within controlled root."""
from __future__ import annotations

import struct
from pathlib import Path
from typing import Union

try:
    import numpy as np
except ImportError:
    np = None

from .backends.base import BackendInputError, validate_audio_path


def read_pcm_wav(
    audio_path: Union[str, Path],
    allowed_audio_root: Path,
) -> np.ndarray:
    """Decode and validate a 16-bit 16kHz PCM WAV file from an allowed audio root.

    Returns:
        1D float32 numpy array normalized to [-1.0, 1.0] at 16000 Hz.
    Raises:
        BackendInputError: If file is outside allowed root, malformed RIFF,
                           missing fmt or data chunk, unsupported encoding,
                           wrong sample rate, truncated, etc.
    """
    valid_path = validate_audio_path(str(audio_path), allowed_audio_root)
    if not valid_path.is_file():
        raise BackendInputError("AUDIO_FILE_NOT_FOUND")

    try:
        data = valid_path.read_bytes()
    except Exception as err:
        raise BackendInputError(f"FAILED_TO_READ_AUDIO_FILE: {err}") from err

    return parse_pcm_wav_bytes(data)


def parse_pcm_wav_bytes(data: bytes) -> np.ndarray:
    """Parse RIFF PCM WAV byte content into a 1D float32 numpy array."""
    if len(data) < 12:
        raise BackendInputError("MALFORMED_RIFF_HEADER")

    riff_tag = data[0:4]
    riff_size = struct.unpack("<I", data[4:8])[0]
    wave_tag = data[8:12]

    if riff_tag != b"RIFF" or wave_tag != b"WAVE":
        raise BackendInputError("MALFORMED_RIFF_HEADER")

    offset = 12
    fmt_parsed = False
    audio_format = 0
    num_channels = 0
    sample_rate = 0
    bits_per_sample = 0
    pcm_samples_bytes = None

    while offset + 8 <= len(data):
        chunk_id = data[offset:offset+4]
        chunk_size = struct.unpack("<I", data[offset+4:offset+8])[0]
        chunk_data_offset = offset + 8
        chunk_end = chunk_data_offset + chunk_size

        if chunk_end > len(data):
            raise BackendInputError("TRUNCATED_WAV_CHUNK")

        if chunk_id == b"fmt ":
            if chunk_size < 16:
                raise BackendInputError("MALFORMED_FMT_CHUNK")
            audio_format, num_channels, sample_rate, byte_rate, block_align, bits_per_sample = struct.unpack(
                "<HHIIHH", data[chunk_data_offset:chunk_data_offset+16]
            )
            # Handle WAVE_FORMAT_EXTENSIBLE (0xFFFE)
            if audio_format == 0xFFFE and chunk_size >= 40:
                sub_format = data[chunk_data_offset+24:chunk_data_offset+40]
                pcm_guid = bytes([
                    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
                    0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71
                ])
                if sub_format == pcm_guid:
                    audio_format = 1

            fmt_parsed = True

        elif chunk_id == b"data":
            if not fmt_parsed:
                raise BackendInputError("MISSING_FMT_CHUNK")
            pcm_samples_bytes = data[chunk_data_offset:chunk_end]
            break

        offset = chunk_end + (chunk_size % 2)

    if not fmt_parsed:
        raise BackendInputError("MISSING_FMT_CHUNK")
    if pcm_samples_bytes is None:
        raise BackendInputError("MISSING_DATA_CHUNK")

    if audio_format != 1:
        raise BackendInputError(f"UNSUPPORTED_ENCODING: {audio_format}")

    if bits_per_sample != 16:
        raise BackendInputError(f"UNSUPPORTED_BIT_DEPTH: {bits_per_sample}")

    if sample_rate != 16000:
        raise BackendInputError(f"UNSUPPORTED_SAMPLE_RATE: {sample_rate} (expected 16000)")

    if num_channels not in (1, 2):
        raise BackendInputError(f"UNSUPPORTED_CHANNELS: {num_channels} (must be mono or stereo)")

    bytes_per_sample = 2
    frame_size = num_channels * bytes_per_sample
    if len(pcm_samples_bytes) % frame_size != 0:
        raise BackendInputError("TRUNCATED_WAV_CHUNK")

    if np is None:
        raise RuntimeError("NumPy is required to decode PCM WAV audio")

    raw_samples = np.frombuffer(pcm_samples_bytes, dtype=np.int16)
    if len(raw_samples) == 0:
        raise BackendInputError("MISSING_DATA_CHUNK")

    float_samples = raw_samples.astype(np.float32) / 32768.0

    if num_channels == 2:
        return ((float_samples[0::2] + float_samples[1::2]) / 2.0).astype(np.float32)

    return float_samples
