import tempfile
import unittest
import base64
import wave
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from native.python.voice_runtime.backends.faster_whisper import FasterWhisperBackend
from native.python.voice_runtime.backends.mlx_whisper import MLXWhisperBackend
from native.python.voice_runtime.backends.kokoro_python import KokoroPythonBackend
from native.python.voice_runtime.backends.kokoro_onnx import KokoroOnnxBackend


class MLXWhisperBackendTest(unittest.TestCase):
    def test_legacy_whisper_model_environment_variable_remains_supported(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            "os.environ",
            {"VOICE_WHISPER_MODEL": "legacy-model"},
            clear=True,
        ):
            backend = MLXWhisperBackend(
                allowed_audio_root=Path(temp_dir),
                transcriber=lambda *_args, **_kwargs: {"text": "ok"},
            )

        self.assertEqual(backend.model_id, "legacy-model")

    def test_transcribe_validates_path_and_uses_injected_transcriber(self):
        calls = []

        def transcriber(path, **kwargs):
            calls.append((path, kwargs))
            return {"text": "  Hello world  "}

        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "sample.wav"
            audio.write_bytes(b"fake")
            backend = MLXWhisperBackend(
                model_id="test-model",
                allowed_audio_root=Path(temp_dir),
                transcriber=transcriber,
            )

            result = backend.transcribe(str(audio), "en")

            self.assertEqual(result, {
                "text": "Hello world",
                "language": "en",
                "model": "test-model",
                "engine": "mlx-whisper",
            })
            self.assertEqual(calls[0][0], str(audio.resolve()))
            self.assertEqual(calls[0][1]["path_or_hf_repo"], "test-model")

            with self.assertRaisesRegex(ValueError, "AUDIO_PATH_OUTSIDE_RUNTIME_TEMP"):
                backend.transcribe("/etc/passwd", "en")
            with self.assertRaisesRegex(ValueError, "INVALID_LANGUAGE"):
                backend.transcribe(str(audio), "../../secret")


def make_valid_wav_bytes(num_samples: int = 160) -> bytes:
    buf = BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x00\x00" * num_samples)
    return buf.getvalue()


class FasterWhisperBackendTest(unittest.TestCase):
    def test_english_only_model_rejects_other_languages(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "sample.wav"
            audio.write_bytes(make_valid_wav_bytes())
            backend = FasterWhisperBackend(
                model_id="base.en",
                allowed_audio_root=Path(temp_dir),
                model_factory=lambda *_args, **_kwargs: object(),
            )

            with self.assertRaisesRegex(ValueError, "UNSUPPORTED_LANGUAGE_FOR_MODEL"):
                backend.transcribe(str(audio), "zh-TW")

    def test_model_is_lazy_loaded_reused_and_segments_are_joined(self):
        loads = []

        class Model:
            def transcribe(self, path, **kwargs):
                return [SimpleNamespace(text=" Hello "), SimpleNamespace(text="world ")], None

        def model_factory(model_id, **kwargs):
            loads.append((model_id, kwargs))
            return Model()

        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "sample.wav"
            audio.write_bytes(make_valid_wav_bytes())
            backend = FasterWhisperBackend(
                model_id="base.en",
                allowed_audio_root=Path(temp_dir),
                model_factory=model_factory,
                audio_decoder=lambda _path, _root: [0.0] * 160,
            )
            self.assertEqual(loads, [])

            first = backend.transcribe(str(audio), "en")
            second = backend.transcribe(str(audio), "en")

            self.assertEqual(first["text"], "Hello world")
            self.assertEqual(first["engine"], "faster-whisper")
            self.assertEqual(second["model"], "base.en")
            self.assertEqual(len(loads), 1)

    def test_cuda_runtime_error_falls_back_to_cpu_and_reuses_session(self):
        loads = []

        class FailingAutoModel:
            def transcribe(self, path, **kwargs):
                raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")

        class WorkingCpuModel:
            def transcribe(self, path, **kwargs):
                return [SimpleNamespace(text="recovered text")], None

        def model_factory(model_id, **kwargs):
            device = kwargs.get("device")
            loads.append(device)
            if device == "auto":
                return FailingAutoModel()
            return WorkingCpuModel()

        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "sample.wav"
            audio.write_bytes(make_valid_wav_bytes())
            backend = FasterWhisperBackend(
                model_id="base.en",
                allowed_audio_root=Path(temp_dir),
                model_factory=model_factory,
                audio_decoder=lambda _path, _root: [0.0] * 160,
                device="auto",
            )
            # First call fails on auto, recovers to cpu
            first = backend.transcribe(str(audio), "en")
            self.assertEqual(first["text"], "recovered text")
            self.assertEqual(backend.device, "cpu")
            self.assertEqual(loads, ["auto", "cpu"])

            # Second call reuses existing CPU session without reloading
            second = backend.transcribe(str(audio), "en")
            self.assertEqual(second["text"], "recovered text")
            self.assertEqual(len(loads), 2)

    def test_cuda_init_error_falls_back_to_cpu(self):
        loads = []

        class WorkingCpuModel:
            def transcribe(self, path, **kwargs):
                return [SimpleNamespace(text="cpu init ok")], None

        def model_factory(model_id, **kwargs):
            device = kwargs.get("device")
            loads.append(device)
            if device == "auto":
                raise RuntimeError("CUDA driver version is insufficient for CUDA runtime version")
            return WorkingCpuModel()

        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "sample.wav"
            audio.write_bytes(make_valid_wav_bytes())
            backend = FasterWhisperBackend(
                model_id="base.en",
                allowed_audio_root=Path(temp_dir),
                model_factory=model_factory,
                audio_decoder=lambda _path, _root: [0.0] * 160,
                device="auto",
            )
            res = backend.transcribe(str(audio), "en")
            self.assertEqual(res["text"], "cpu init ok")
            self.assertEqual(backend.device, "cpu")
            self.assertEqual(loads, ["auto", "cpu"])

    def test_unrelated_errors_are_not_swallowed(self):
        # 1. Unrelated init error
        def failing_init_factory(model_id, **kwargs):
            raise FileNotFoundError("Model file does not exist")

        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "sample.wav"
            audio.write_bytes(make_valid_wav_bytes())
            backend = FasterWhisperBackend(
                model_id="base.en",
                allowed_audio_root=Path(temp_dir),
                model_factory=failing_init_factory,
                audio_decoder=lambda _path, _root: [0.0] * 160,
                device="auto",
            )
            with self.assertRaises(FileNotFoundError):
                backend.transcribe(str(audio), "en")

        # 2. Unrelated transcribe error
        class CorruptModel:
            def transcribe(self, path, **kwargs):
                raise ValueError("Corrupt audio stream: invalid header")

        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "sample.wav"
            audio.write_bytes(make_valid_wav_bytes())
            backend = FasterWhisperBackend(
                model_id="base.en",
                allowed_audio_root=Path(temp_dir),
                model_factory=lambda *a, **k: CorruptModel(),
                audio_decoder=lambda _path, _root: [0.0] * 160,
                device="auto",
            )
            with self.assertRaises(ValueError):
                backend.transcribe(str(audio), "en")


class KokoroPythonBackendTest(unittest.TestCase):
    def test_pipeline_is_lazy_reused_and_returns_wav(self):
        loads = []

        class Pipeline:
            def __call__(self, text, voice, speed):
                yield None, None, [0.0, 0.25, -0.25]

        def pipeline_factory():
            loads.append("loaded")
            return Pipeline()

        backend = KokoroPythonBackend(pipeline_factory=pipeline_factory)
        self.assertEqual(loads, [])

        first = backend.synthesize("Hello ✨", "af_heart", 1.0)
        second = backend.synthesize("Again", "af_heart", 1.0)

        self.assertEqual(loads, ["loaded"])
        self.assertEqual(first["engine"], "kokoro-python")
        self.assertEqual(second["format"], "audio/wav")
        with wave.open(BytesIO(base64.b64decode(first["audio"])), "rb") as wav_file:
            self.assertEqual(wav_file.getframerate(), 24000)
            self.assertEqual(wav_file.getnchannels(), 1)
        with self.assertRaisesRegex(ValueError, "INVALID_TEXT_LENGTH"):
            backend.synthesize("x" * 5001, "af_heart", 1.0)


class KokoroOnnxBackendTest(unittest.TestCase):
    def test_empty_engine_audio_is_rejected(self):
        class EmptyEngine:
            def create(self, text, voice, speed, lang):
                return [], 24000

        with tempfile.TemporaryDirectory() as temp_dir:
            model = Path(temp_dir) / "model.onnx"
            voices = Path(temp_dir) / "voices.bin"
            model.write_bytes(b"model")
            voices.write_bytes(b"voices")
            backend = KokoroOnnxBackend(
                model_path=model,
                voices_path=voices,
                engine_factory=lambda *_args: EmptyEngine(),
            )

            with self.assertRaisesRegex(RuntimeError, "NO_AUDIO_GENERATED"):
                backend.synthesize("Hello", "af_heart", 1.0)

    def test_engine_assets_are_validated_and_engine_is_reused(self):
        loads = []

        class Engine:
            def create(self, text, voice, speed, lang):
                return [0.0, 0.1, -0.1], 22050

        def engine_factory(model_path, voices_path):
            loads.append((model_path, voices_path))
            return Engine()

        with tempfile.TemporaryDirectory() as temp_dir:
            model = Path(temp_dir) / "kokoro-v1.0.onnx"
            voices = Path(temp_dir) / "voices-v1.0.bin"
            model.write_bytes(b"model")
            voices.write_bytes(b"voices")
            backend = KokoroOnnxBackend(
                model_path=model,
                voices_path=voices,
                engine_factory=engine_factory,
            )
            self.assertEqual(loads, [])

            result = backend.synthesize("Hello", "af_heart", 1.0)
            backend.synthesize("Again", "af_heart", 1.0)

            self.assertEqual(len(loads), 1)
            self.assertEqual(result["engine"], "kokoro-onnx")
            self.assertEqual(result["sampleRate"], 22050)


if __name__ == "__main__":
    unittest.main()
