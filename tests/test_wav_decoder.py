import io
import struct
import tempfile
import unittest
from pathlib import Path

try:
    import numpy as np
    HAVE_NUMPY = True
except ImportError:
    np = None
    HAVE_NUMPY = False

from native.python.voice_runtime.backends.base import BackendInputError
from native.python.voice_runtime.wav_decoder import parse_pcm_wav_bytes, read_pcm_wav


def make_wav_bytes(
    sample_rate: int = 16000,
    channels: int = 1,
    bits_per_sample: int = 16,
    audio_format: int = 1,
    num_samples: int = 160,
    truncate_data_by: int = 0,
    omit_fmt: bool = False,
    omit_data: bool = False,
    corrupt_riff: bool = False,
) -> bytes:
    buf = io.BytesIO()
    # Placeholder for RIFF header
    buf.write(b"RIFF\x00\x00\x00\x00WAVE")

    if not omit_fmt:
        fmt_data = struct.pack(
            "<HHIIHH",
            audio_format,
            channels,
            sample_rate,
            sample_rate * channels * (bits_per_sample // 8),
            channels * (bits_per_sample // 8),
            bits_per_sample,
        )
        buf.write(b"fmt ")
        buf.write(struct.pack("<I", len(fmt_data)))
        buf.write(fmt_data)

    if not omit_data:
        data_bytes_len = num_samples * channels * (bits_per_sample // 8)
        buf.write(b"data")
        buf.write(struct.pack("<I", data_bytes_len))
        raw = b"\x00" * data_bytes_len
        if truncate_data_by > 0:
            raw = raw[:-truncate_data_by]
        buf.write(raw)

    data = bytearray(buf.getvalue())
    file_size_minus_8 = len(data) - 8
    data[4:8] = struct.pack("<I", file_size_minus_8)

    if corrupt_riff:
        data[0:4] = b"NOPE"

    return bytes(data)


@unittest.skipUnless(HAVE_NUMPY, "NumPy not available in source test environment")
class TestWavDecoder(unittest.TestCase):
    def test_valid_mono_pcm_wav(self):
        wav_data = make_wav_bytes(sample_rate=16000, channels=1, bits_per_sample=16, num_samples=320)
        samples = parse_pcm_wav_bytes(wav_data)
        self.assertIsInstance(samples, np.ndarray)
        self.assertEqual(samples.dtype, np.float32)
        self.assertEqual(len(samples), 320)
        self.assertTrue(-1.0 <= samples.min() <= 1.0)
        self.assertTrue(-1.0 <= samples.max() <= 1.0)

    def test_valid_stereo_handling(self):
        # Stereo audio with left=1000, right=2000
        num_frames = 100
        left = (np.ones(num_frames, dtype=np.int16) * 1000).tobytes()
        right = (np.ones(num_frames, dtype=np.int16) * 3000).tobytes()
        interleaved = bytearray()
        for i in range(num_frames):
            interleaved.extend(left[i*2:(i+1)*2])
            interleaved.extend(right[i*2:(i+1)*2])

        buf = io.BytesIO()
        buf.write(b"RIFF\x00\x00\x00\x00WAVE")
        fmt = struct.pack("<HHIIHH", 1, 2, 16000, 16000*4, 4, 16)
        buf.write(b"fmt " + struct.pack("<I", len(fmt)) + fmt)
        buf.write(b"data" + struct.pack("<I", len(interleaved)) + bytes(interleaved))
        data = bytearray(buf.getvalue())
        data[4:8] = struct.pack("<I", len(data) - 8)

        samples = parse_pcm_wav_bytes(bytes(data))
        self.assertEqual(len(samples), num_frames)
        # Average of (1000 + 3000) / 2 = 2000. Normalized: 2000 / 32768.0 = 0.061035156
        expected_val = 2000.0 / 32768.0
        np.testing.assert_allclose(samples[0], expected_val, rtol=1e-4)

    def test_malformed_riff_header(self):
        bad_data = make_wav_bytes(corrupt_riff=True)
        with self.assertRaisesRegex(BackendInputError, "MALFORMED_RIFF_HEADER"):
            parse_pcm_wav_bytes(bad_data)

        with self.assertRaisesRegex(BackendInputError, "MALFORMED_RIFF_HEADER"):
            parse_pcm_wav_bytes(b"short")

    def test_missing_fmt_chunk(self):
        bad_data = make_wav_bytes(omit_fmt=True)
        with self.assertRaisesRegex(BackendInputError, "MISSING_FMT_CHUNK"):
            parse_pcm_wav_bytes(bad_data)

    def test_missing_data_chunk(self):
        bad_data = make_wav_bytes(omit_data=True)
        with self.assertRaisesRegex(BackendInputError, "MISSING_DATA_CHUNK"):
            parse_pcm_wav_bytes(bad_data)

    def test_unsupported_encoding_float(self):
        # Format 3 = IEEE float
        bad_data = make_wav_bytes(audio_format=3, bits_per_sample=32)
        with self.assertRaisesRegex(BackendInputError, "UNSUPPORTED_ENCODING"):
            parse_pcm_wav_bytes(bad_data)

    def test_unsupported_encoding_alaw(self):
        # Format 6 = A-law
        bad_data = make_wav_bytes(audio_format=6, bits_per_sample=8)
        with self.assertRaisesRegex(BackendInputError, "UNSUPPORTED_ENCODING"):
            parse_pcm_wav_bytes(bad_data)

    def test_unsupported_sample_rate(self):
        # 44100 Hz must be rejected, not silently misinterpreted
        bad_data = make_wav_bytes(sample_rate=44100)
        with self.assertRaisesRegex(BackendInputError, "UNSUPPORTED_SAMPLE_RATE: 44100"):
            parse_pcm_wav_bytes(bad_data)

        # 8000 Hz must be rejected
        bad_data2 = make_wav_bytes(sample_rate=8000)
        with self.assertRaisesRegex(BackendInputError, "UNSUPPORTED_SAMPLE_RATE: 8000"):
            parse_pcm_wav_bytes(bad_data2)

    def test_truncated_chunk(self):
        # Data chunk declares 320 bytes, but has 10 bytes missing
        bad_data = make_wav_bytes(truncate_data_by=10)
        with self.assertRaisesRegex(BackendInputError, "TRUNCATED_WAV_CHUNK"):
            parse_pcm_wav_bytes(bad_data)

    def test_traversal_and_allowed_root_rejection(self):
        with tempfile.TemporaryDirectory() as temp_root_str:
            temp_root = Path(temp_root_str).resolve()
            valid_file = temp_root / "test.wav"
            valid_file.write_bytes(make_wav_bytes())

            # Valid inside root
            samples = read_pcm_wav(str(valid_file), temp_root)
            self.assertEqual(len(samples), 160)

            # Outside root
            with tempfile.TemporaryDirectory() as outside_dir_str:
                outside_file = Path(outside_dir_str) / "outside.wav"
                outside_file.write_bytes(make_wav_bytes())
                with self.assertRaisesRegex(BackendInputError, "AUDIO_PATH_OUTSIDE_RUNTIME_TEMP"):
                    read_pcm_wav(str(outside_file), temp_root)

            # Traversal string
            traversal_path = str(temp_root / "../etc/passwd")
            with self.assertRaisesRegex(BackendInputError, "AUDIO_PATH_OUTSIDE_RUNTIME_TEMP"):
                read_pcm_wav(traversal_path, temp_root)

    def test_native_whisper_real_inference(self):
        """Verify WhisperModel runs real inference on decoded PCM WAV samples without PyAV."""
        model_path = Path("dist/artifacts-staging/whisper-base-en").resolve()
        if not (model_path / "model.bin").is_file():
            self.skipTest("whisper-base-en model not staged")

        import sys
        from faster_whisper import WhisperModel

        model = WhisperModel(str(model_path), device="cpu", compute_type="int8")
        with tempfile.TemporaryDirectory() as temp_root_str:
            temp_root = Path(temp_root_str).resolve()
            wav_file = temp_root / "inference_test.wav"
            wav_file.write_bytes(make_wav_bytes(sample_rate=16000, channels=1, bits_per_sample=16, num_samples=16000))

            samples = read_pcm_wav(str(wav_file), temp_root)
            segments, info = model.transcribe(samples, language="en")
            results = list(segments)
            self.assertIsNotNone(info)
            self.assertEqual(info.language, "en")
            self.assertNotIn("av", sys.modules, "PyAV must not be loaded in sys.modules")


if __name__ == "__main__":
    unittest.main()
