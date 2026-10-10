"""Real WAV/NumPy tests; only the inference model boundary is doubled."""
import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from native.python.voice_runtime.backends.base import BackendInputError
from native.python.voice_runtime.backends.faster_whisper import FasterWhisperBackend
from native.python.voice_runtime.wav_decoder import decode_wav


def chunk(tag, payload):
    return tag + struct.pack("<I", len(payload)) + payload + b"\0" * (len(payload) % 2)


def riff(*chunks):
    body = b"WAVE" + b"".join(chunks)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def fmt(*, tag=1, channels=1, rate=16000, bits=16, align=None, byte_rate=None):
    align = channels * (bits // 8) if align is None else align
    byte_rate = rate * align if byte_rate is None else byte_rate
    return struct.pack("<HHIIHH", tag, channels, rate, byte_rate, align, bits)


def wav(samples=(0, 16384), *, channels=1):
    return riff(chunk(b"fmt ", fmt(channels=channels)),
                chunk(b"data", struct.pack("<" + "h" * len(samples), *samples)))


class WavDecoderTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "input.wav"
        self.loads = []
        self.calls = []

        def transcribe(audio, **kwargs):
            self.calls.append((audio, kwargs))
            return [SimpleNamespace(text=" decoded ")], None

        def factory(model, **kwargs):
            self.loads.append((model, kwargs))
            return SimpleNamespace(transcribe=transcribe, supported_languages=["en", "zh"])

        self.backend = FasterWhisperBackend(
            model_id="base", allowed_audio_root=self.root, model_factory=factory,
            device="cuda", compute_type="float16")

    def assert_audio(self, samples, expected):
        self.assertIsInstance(samples, np.ndarray)
        self.assertEqual(samples.dtype, np.float32)
        self.assertEqual(samples.shape, (len(expected),))
        self.assertTrue(samples.flags.c_contiguous)
        np.testing.assert_array_equal(samples, np.array(expected, dtype=np.float32))

    def assert_rejected(self, payload, code="INVALID_WAV"):
        self.path.write_bytes(payload)
        with self.assertRaisesRegex(BackendInputError, "^" + code + "$"):
            self.backend.transcribe(str(self.path), "en")
        self.assertEqual(self.loads, [], "Invalid input must not initialize a model")
        self.assertEqual(self.calls, [])

    def test_riff_structure_is_strict_before_model_creation(self):
        canonical = wav()
        format_chunk = chunk(b"fmt ", fmt())
        data_chunk = chunk(b"data", b"\0\0\0\x40")
        cases = {
            "wrong-riff": b"RIFX" + canonical[4:],
            "wrong-wave": canonical[:8] + b"AVI " + canonical[12:],
            "trailing-bytes": canonical + b"x",
            "riff-size-small": canonical[:4] + struct.pack("<I", 4) + canonical[8:],
            "riff-size-huge": canonical[:4] + struct.pack("<I", 0xffffffff) + canonical[8:],
            "missing-fmt": riff(data_chunk),
            "missing-data": riff(format_chunk),
            "data-before-fmt": riff(data_chunk, format_chunk),
            "duplicate-fmt": riff(format_chunk, format_chunk, data_chunk),
            "duplicate-data": riff(format_chunk, data_chunk, data_chunk),
            "short-fmt": riff(chunk(b"fmt ", b"\0" * 14), data_chunk),
            "empty-data": riff(format_chunk, chunk(b"data", b"")),
            "partial-mono-frame": riff(format_chunk, chunk(b"data", b"\0")),
            "partial-stereo-frame": riff(chunk(b"fmt ", fmt(channels=2)), chunk(b"data", b"\0\0")),
            "huge-chunk": riff(format_chunk, b"data\xff\xff\xff\xff"),
            "incomplete-chunk-header": riff(format_chunk, data_chunk, b"JUNK\0"),
            "missing-odd-padding": riff(format_chunk, data_chunk, b"JUNK\x01\0\0\0x"),
        }
        cases.update({f"truncated-at-{i}": canonical[:i] for i in range(len(canonical))})
        for name, payload in cases.items():
            with self.subTest(name=name):
                self.assert_rejected(payload)

    def test_padded_unknown_chunks_and_trailing_metadata_preserve_pcm(self):
        self.path.write_bytes(riff(
            chunk(b"JUNK", b"odd"), chunk(b"fmt ", fmt()), chunk(b"LIST", b"info"),
            chunk(b"data", b"\0\x80\xff\x7f"), chunk(b"JUNK", b"x")))
        self.assert_audio(decode_wav(self.path), [-1, 32767 / 32768])

    def test_unsupported_formats_are_rejected_without_model_creation(self):
        pcm_guid = bytes.fromhex("0100000000001000800000aa00389b71")
        cases = {
            "float": fmt(tag=3), "compressed": fmt(tag=6),
            "extensible-pcm": fmt(tag=0xfffe) + struct.pack("<HHI", 22, 16, 4) + pcm_guid,
            "zero-channels": fmt(channels=0), "three-channels": fmt(channels=3),
            "rate-8k": fmt(rate=8000), "rate-44k": fmt(rate=44100), "rate-zero": fmt(rate=0),
            "8-bit": fmt(bits=8), "24-bit": fmt(bits=24), "32-bit": fmt(bits=32),
            "wrong-align": fmt(align=4), "wrong-byte-rate": fmt(byte_rate=1),
            "stereo-wrong-align": fmt(channels=2, align=2),
            "short-extension": fmt() + b"\0", "nonzero-extension": fmt() + b"\x01\0",
            "extra-extension": fmt() + b"\x02\0\0\0",
        }
        for name, format_bytes in cases.items():
            with self.subTest(name=name):
                self.assert_rejected(riff(chunk(b"fmt ", format_bytes), chunk(b"data", b"\0" * 12)),
                                     "UNSUPPORTED_WAV_FORMAT")

    def test_pcm_with_zero_length_extension_is_supported(self):
        self.path.write_bytes(riff(chunk(b"fmt ", fmt() + b"\0\0"), chunk(b"data", b"\0\x40")))
        self.assert_audio(decode_wav(self.path), [0.5])

    def test_path_and_language_authority_precedes_decoder_and_model(self):
        with tempfile.TemporaryDirectory() as outside_dir:
            outside = Path(outside_dir) / "invalid.wav"
            outside.write_bytes(b"not WAV")
            for path in (outside, self.root / ".." / Path(outside_dir).name / "invalid.wav"):
                with self.subTest(path=path):
                    with self.assertRaisesRegex(BackendInputError, "AUDIO_PATH_OUTSIDE_RUNTIME_TEMP"):
                        self.backend.transcribe(str(path), "en")
        for path in (self.root, self.root / "missing.wav"):
            with self.assertRaisesRegex(BackendInputError, "AUDIO_FILE_NOT_FOUND"):
                self.backend.transcribe(str(path), "en")
        self.path.write_bytes(b"not WAV")
        with self.assertRaisesRegex(BackendInputError, "INVALID_LANGUAGE"):
            self.backend.transcribe(str(self.path), "../../secret")
        self.backend.model_id = "BASE.EN"
        with self.assertRaisesRegex(BackendInputError, "INVALID_WAV"):
            self.backend.transcribe(str(self.path), "zh-TW")
        self.assertEqual(self.loads, [])
        self.assertEqual(self.calls, [])

    def test_file_byte_limit_is_inclusive_and_checked_before_parsing(self):
        limit = 25 * 1024 * 1024
        canonical = wav()
        header = canonical[:4] + struct.pack("<I", limit - 8) + canonical[8:]
        with self.path.open("wb") as stream:
            stream.write(header)
            stream.write(b"JUNK" + struct.pack("<I", limit - len(canonical) - 8))
            stream.seek(limit - 1)
            stream.write(b"\0")
        self.assert_audio(decode_wav(self.path), [0, 0.5])
        with self.path.open("ab") as stream:
            stream.write(b"\0")
        with self.assertRaisesRegex(BackendInputError, "^AUDIO_PAYLOAD_TOO_LARGE$"):
            self.backend.transcribe(str(self.path), "en")
        self.assertEqual(self.loads, [])
        self.assertEqual(self.calls, [])

    def test_model_failures_do_not_change_device_policy_or_fall_back(self):
        self.path.write_bytes(wav())
        attempts = []

        def fail_model(model, **kwargs):
            attempts.append((model, kwargs))
            raise RuntimeError("model boundary failure")

        backend = FasterWhisperBackend(
            model_id="base", allowed_audio_root=self.root, model_factory=fail_model,
            device="auto", compute_type="int8")
        with self.assertRaisesRegex(RuntimeError, "^model boundary failure$"):
            backend.transcribe(str(self.path), "en")
        self.assertEqual(attempts, [("base", {"device": "auto", "compute_type": "int8"})])

    def test_invalid_wav_after_warm_model_is_not_sent_to_model(self):
        self.path.write_bytes(wav())
        self.backend.transcribe(str(self.path), "en")
        self.path.write_bytes(b"invalid")
        with self.assertRaisesRegex(BackendInputError, "^INVALID_WAV$"):
            self.backend.transcribe(str(self.path), "en")
        self.assertEqual(len(self.loads), 1)
        self.assertEqual(len(self.calls), 1)

    def test_stereo_downmix_is_float32_without_integer_overflow(self):
        self.path.write_bytes(wav(
            (-32768, -32768, 32767, 32767, -32768, 32767, 16384, 0), channels=2))
        expected = [-1, 32767 / 32768, -1 / 65536, 0.25]
        self.assert_audio(decode_wav(self.path), expected)
        result = self.backend.transcribe(str(self.path), "zh-TW")
        self.assertEqual(result, {
            "text": "decoded", "language": "zh", "model": "base", "engine": "faster-whisper"})
        self.assert_audio(self.calls[0][0], expected)
        self.assertEqual(self.calls[0][1], {
            "language": "zh", "condition_on_previous_text": False, "vad_filter": True})
        self.assertEqual(self.loads, [("base", {"device": "cuda", "compute_type": "float16"})])
