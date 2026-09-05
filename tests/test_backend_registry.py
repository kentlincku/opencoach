import os
import tempfile
import unittest
from unittest.mock import patch

from native.python.voice_runtime.backend_registry import BackendRegistry, detect_availability
from native.python.voice_runtime.backends.base import BackendUnavailableError

os.environ.setdefault("VOICE_RUNTIME_TEMP_DIR", tempfile.gettempdir())
from native.python.voice_runtime import server


class FakeSTT:
    def __init__(self):
        self.calls = []

    def transcribe(self, audio_path, language="en"):
        self.calls.append((audio_path, language))
        return {"text": "hello", "language": language, "model": "fake-stt"}


class FakeTTS:
    def __init__(self):
        self.calls = []

    def synthesize(self, text, voice, speed):
        self.calls.append((text, voice, speed))
        return {"audio": "wav", "format": "audio/wav", "sampleRate": 24000}


class BackendRegistryTest(unittest.TestCase):
    def test_malformed_audio_path_is_input_error_not_backend_failure(self):
        with patch.dict(os.environ, {}, clear=True):
            registry = BackendRegistry(platform_name="linux", arch_name="x64", fake=True)

        with self.assertRaisesRegex(ValueError, "INVALID_AUDIO_PATH"):
            registry.transcribe("bad\x00path", "en")
        self.assertTrue(registry.capabilities()["ready"])

    def test_fake_registry_keeps_temp_path_containment_without_env(self):
        with patch.dict(os.environ, {}, clear=True):
            registry = BackendRegistry(platform_name="linux", arch_name="x64", fake=True)

        with self.assertRaisesRegex(ValueError, "AUDIO_PATH_OUTSIDE_RUNTIME_TEMP"):
            registry.transcribe("/etc/passwd", "en")

    def test_lazy_model_unavailability_degrades_health_and_is_not_retried(self):
        calls = []

        class LazyBrokenSTT:
            def transcribe(self, _path, _language):
                calls.append("attempt")
                raise BackendUnavailableError("stt", "faster-whisper", "dependency import failed")

        registry = BackendRegistry(
            platform_name="linux",
            arch_name="x64",
            stt_choice="faster-whisper",
            tts_choice="kokoro-onnx",
            availability={"faster-whisper": True, "kokoro-onnx": True},
            factories={"faster-whisper": LazyBrokenSTT},
        )

        with self.assertRaisesRegex(RuntimeError, "BACKEND_UNAVAILABLE"):
            registry.transcribe("/tmp/a.wav", "en")
        self.assertIsNone(registry.capabilities()["selectedStt"])
        with self.assertRaisesRegex(RuntimeError, "BACKEND_UNAVAILABLE"):
            registry.transcribe("/tmp/a.wav", "en")
        self.assertEqual(calls, ["attempt"])

    def test_failed_initialization_degrades_health_and_is_not_retried(self):
        loads = []

        def broken_factory():
            loads.append("attempt")
            raise RuntimeError("cannot initialize")

        registry = BackendRegistry(
            platform_name="linux",
            arch_name="x64",
            stt_choice="faster-whisper",
            tts_choice="kokoro-onnx",
            availability={"faster-whisper": True, "kokoro-onnx": True},
            factories={"faster-whisper": broken_factory},
        )

        with self.assertRaisesRegex(RuntimeError, "BACKEND_UNAVAILABLE"):
            registry.transcribe("/tmp/a.wav", "en")
        capabilities = registry.capabilities()
        self.assertIsNone(capabilities["selectedStt"])
        self.assertNotIn("faster-whisper", capabilities["sttBackends"])
        self.assertFalse(capabilities["ready"])
        with self.assertRaisesRegex(RuntimeError, "BACKEND_UNAVAILABLE"):
            registry.transcribe("/tmp/a.wav", "en")
        self.assertEqual(loads, ["attempt"])

    def test_health_reports_execution_provider_only_after_tts_engine_load(self):
        class ProviderTTS(FakeTTS):
            execution_provider = "CPUExecutionProvider"

        registry = BackendRegistry(
            platform_name="windows",
            arch_name="x64",
            stt_choice="faster-whisper",
            tts_choice="kokoro-onnx",
            availability={"faster-whisper": True, "kokoro-onnx": True},
            factories={"kokoro-onnx": ProviderTTS},
        )

        self.assertIsNone(registry.capabilities()["executionProvider"])
        registry.synthesize("Hello", "af_heart", 1.0)
        self.assertEqual(registry.capabilities()["executionProvider"], "CPUExecutionProvider")

    def test_auto_prefers_onnx_tts_off_apple_silicon(self):
        registry = BackendRegistry(
            platform_name="linux",
            arch_name="x64",
            availability={
                "faster-whisper": True,
                "kokoro-python": True,
                "kokoro-onnx": True,
            },
        )

        self.assertEqual(registry.capabilities()["selectedTts"], "kokoro-onnx")

    def test_onnx_is_not_advertised_without_model_assets(self):
        with (
            patch("native.python.voice_runtime.backend_registry._module_available", return_value=True),
            patch.dict(os.environ, {}, clear=True),
        ):
            availability = detect_availability()

        self.assertFalse(availability["kokoro-onnx"])

    def test_offline_backends_require_existing_local_model_assets(self):
        with (
            patch("native.python.voice_runtime.backend_registry._module_available", return_value=True),
            patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}, clear=True),
        ):
            unavailable = detect_availability()

        self.assertFalse(unavailable["mlx-whisper"])
        self.assertFalse(unavailable["faster-whisper"])
        self.assertFalse(unavailable["kokoro-python"])
        self.assertFalse(unavailable["kokoro-onnx"])

        with tempfile.TemporaryDirectory() as root:
            mlx_model = os.path.join(root, "mlx")
            kokoro_model = os.path.join(root, "kokoro")
            os.mkdir(mlx_model)
            os.mkdir(kokoro_model)
            with (
                patch("native.python.voice_runtime.backend_registry._module_available", return_value=True),
                patch.dict(os.environ, {
                    "HF_HUB_OFFLINE": "1",
                    "VOICE_MLX_WHISPER_MODEL": mlx_model,
                    "VOICE_KOKORO_MODEL": kokoro_model,
                }, clear=True),
            ):
                available = detect_availability()

        self.assertTrue(available["mlx-whisper"])
        self.assertTrue(available["kokoro-python"])
        self.assertFalse(available["faster-whisper"])
        self.assertFalse(available["kokoro-onnx"])

    def test_server_dispatch_delegates_speech_operations_to_registry(self):
        calls = []

        class Registry:
            def transcribe(self, path, language):
                calls.append(("stt", path, language))
                return {"text": "registry stt"}

            def synthesize(self, text, voice, speed):
                calls.append(("tts", text, voice, speed))
                return {"audio": "registry tts"}

        with patch.object(server, "backend_registry", Registry(), create=True):
            self.assertEqual(
                server.dispatch("stt.transcribe", {"audioPath": "/tmp/a.wav", "language": "en"}),
                {"text": "registry stt"},
            )
            self.assertEqual(
                server.dispatch("tts.synthesize", {"text": "Hi", "voice": "af_heart", "speed": 1}),
                {"audio": "registry tts"},
            )

        self.assertEqual(calls, [
            ("stt", "/tmp/a.wav", "en"),
            ("tts", "Hi", "af_heart", 1.0),
        ])

    def test_linux_never_selects_or_advertises_mlx(self):
        registry = BackendRegistry(
            platform_name="linux",
            arch_name="x64",
            stt_choice="mlx",
            tts_choice="kokoro-onnx",
            availability={
                "mlx-whisper": True,
                "faster-whisper": True,
                "kokoro-onnx": True,
            },
        )

        capabilities = registry.capabilities()
        self.assertNotIn("mlx-whisper", capabilities["sttBackends"])
        self.assertIsNone(capabilities["selectedStt"])
        self.assertFalse(capabilities["ready"])
        with self.assertRaisesRegex(RuntimeError, "BACKEND_UNAVAILABLE:stt:none"):
            registry.transcribe("/tmp/a.wav")

    def test_unknown_backend_choice_is_not_echoed_in_error(self):
        registry = BackendRegistry(
            platform_name="linux",
            arch_name="x64",
            stt_choice="/home/alice/private/backend",
            tts_choice="unknown",
            availability={},
        )

        with self.assertRaisesRegex(RuntimeError, r"^BACKEND_UNAVAILABLE:stt:none:not available$"):
            registry.transcribe("/tmp/a.wav", "en")

    def test_factory_errors_are_mapped_without_leaking_details(self):
        def broken_factory():
            raise RuntimeError("private host path /secret/model")

        registry = BackendRegistry(
            platform_name="linux",
            arch_name="x64",
            stt_choice="faster-whisper",
            tts_choice="kokoro-onnx",
            availability={"faster-whisper": True, "kokoro-onnx": True},
            factories={"faster-whisper": broken_factory},
        )

        with self.assertRaisesRegex(
            RuntimeError,
            r"^BACKEND_UNAVAILABLE:stt:faster-whisper:initialization failed$",
        ):
            registry.transcribe("/tmp/a.wav", "en")

    def test_unexpected_backend_errors_are_mapped_without_leaking_details(self):
        class BrokenSTT:
            def transcribe(self, _path, _language):
                raise RuntimeError("driver failed with sensitive local detail")

        registry = BackendRegistry(
            platform_name="linux",
            arch_name="x64",
            stt_choice="faster-whisper",
            tts_choice="kokoro-onnx",
            availability={"faster-whisper": True, "kokoro-onnx": True},
            factories={"faster-whisper": BrokenSTT},
        )

        with self.assertRaisesRegex(RuntimeError, r"^BACKEND_ERROR:stt:faster-whisper$"):
            registry.transcribe("/tmp/a.wav", "en")

    def test_third_party_value_errors_are_mapped_without_leaking_details(self):
        class BrokenSTT:
            def transcribe(self, _path, _language):
                raise ValueError("bad asset /home/alice/private/model.bin")

        registry = BackendRegistry(
            platform_name="linux",
            arch_name="x64",
            stt_choice="faster-whisper",
            tts_choice="kokoro-onnx",
            availability={"faster-whisper": True, "kokoro-onnx": True},
            factories={"faster-whisper": BrokenSTT},
        )

        with self.assertRaisesRegex(RuntimeError, r"^BACKEND_ERROR:stt:faster-whisper$"):
            registry.transcribe("/tmp/a.wav", "en")

    def test_cancel_only_forwards_to_loaded_backends(self):
        loads = {"stt": 0, "tts": 0}
        cancellations = []

        class CancellableSTT(FakeSTT):
            def cancel(self):
                cancellations.append("stt")

        registry = BackendRegistry(
            platform_name="linux",
            arch_name="x64",
            stt_choice="faster-whisper",
            tts_choice="kokoro-onnx",
            availability={"faster-whisper": True, "kokoro-onnx": True},
            factories={
                "faster-whisper": lambda: (loads.__setitem__("stt", loads["stt"] + 1) or CancellableSTT()),
                "kokoro-onnx": lambda: (loads.__setitem__("tts", loads["tts"] + 1) or FakeTTS()),
            },
        )

        registry.cancel()
        self.assertEqual(loads, {"stt": 0, "tts": 0})
        registry.transcribe("/tmp/a.wav")
        registry.cancel()
        self.assertEqual(cancellations, ["stt"])
        self.assertEqual(loads, {"stt": 1, "tts": 0})

    def test_backends_are_lazy_loaded_and_reused(self):
        loads = {"stt": 0, "tts": 0}

        def make_stt():
            loads["stt"] += 1
            return FakeSTT()

        def make_tts():
            loads["tts"] += 1
            return FakeTTS()

        registry = BackendRegistry(
            platform_name="linux",
            arch_name="x64",
            stt_choice="faster-whisper",
            tts_choice="kokoro-onnx",
            availability={"faster-whisper": True, "kokoro-onnx": True},
            factories={"faster-whisper": make_stt, "kokoro-onnx": make_tts},
        )

        self.assertEqual(loads, {"stt": 0, "tts": 0})
        self.assertEqual(registry.capabilities()["selectedStt"], "faster-whisper")
        self.assertEqual(loads, {"stt": 0, "tts": 0})

        self.assertEqual(registry.transcribe("/tmp/a.wav", "en")["text"], "hello")
        self.assertEqual(registry.transcribe("/tmp/b.wav", "en")["text"], "hello")
        self.assertEqual(registry.synthesize("Hello", "af_heart", 1.0)["format"], "audio/wav")
        self.assertEqual(registry.synthesize("Again", "af_heart", 1.0)["format"], "audio/wav")
        self.assertEqual(loads, {"stt": 1, "tts": 1})


if __name__ == "__main__":
    unittest.main()
