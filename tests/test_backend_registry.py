import os
import sys
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
    def test_private_root_metadata_selects_managed_backends_without_upstream_roots(self):
        from pathlib import Path
        with tempfile.TemporaryDirectory() as temp:
            model = Path(temp) / 'model.onnx'
            voices = Path(temp) / 'voices.npz'
            model.touch(); voices.touch()
            for private in (True, False):
                queried = []

                def spec(name):
                    queried.append(name)
                    self.assertNotIn('.', name, 'availability must inspect inert roots only')
                    return object() if name in ({'numpy', 'voice_practice_speech_vendor'} if private
                                               else {'numpy', 'faster_whisper', 'kokoro_onnx'}) else None

                with self.subTest(private=private), patch.dict(os.environ, {
                    'VOICE_KOKORO_ONNX_MODEL': str(model), 'VOICE_KOKORO_ONNX_VOICES': str(voices),
                    'VOICE_STT_BACKEND': 'auto', 'VOICE_TTS_BACKEND': 'auto',
                }), patch('importlib.util.find_spec', side_effect=spec):
                    registry = BackendRegistry(platform_name='win32', arch_name='x64')
                    caps = registry.capabilities()
                    self.assertEqual(caps['selectedStt'], 'faster-whisper' if private else None)
                    self.assertEqual(caps['selectedTts'], 'kokoro-onnx' if private else None)
                    self.assertEqual(caps['ready'], private)
                    self.assertIsNone(registry._tts)
                    self.assertIsNone(registry._stt)
                    self.assertNotIn('faster_whisper', queried)
                    self.assertNotIn('kokoro_onnx', queried)

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


class LocalSTTDispatchTest(unittest.TestCase):
    """Real dispatch/registry/backend/WAV; availability and model boundary doubled.

    V4 production availability metadata is deliberately not claimed here.
    """
    def setUp(self):
        from pathlib import Path
        from types import SimpleNamespace
        import wave

        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.audio = self.root / "input.wav"
        with wave.open(str(self.audio), "wb") as wav_file:
            wav_file.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            wav_file.writeframes(b"\x00\x80\x00\x00\x00\x40\xff\x7f")
        self.model_dir = self.root / "private-model"
        self.model_dir.mkdir()
        (self.model_dir / "tokenizer.json").write_text("{}")
        self.loads, self.calls, self.events = [], [], []
        self.model = SimpleNamespace(supported_languages=["en", "zh"], transcribe=self.transcribe)
        self.enterContext(patch.dict(os.environ, {
            "HF_HUB_OFFLINE": "0", "TRANSFORMERS_OFFLINE": "0",
        }))

    def transcribe(self, audio, **kwargs):
        from types import SimpleNamespace
        self.calls.append((audio, kwargs))

        def segments():
            self.events.append("started")
            yield SimpleNamespace(text=" Hello ")
            yield SimpleNamespace(text=" ")
            yield SimpleNamespace(text="world ")
            self.events.append("completed")
        return segments(), None

    def registry(self, model_id=None, factory=None):
        from native.python.voice_runtime.backends.faster_whisper import FasterWhisperBackend

        def model_factory(model, **kwargs):
            self.loads.append((model, kwargs))
            return self.model

        return BackendRegistry(
            platform_name="windows", arch_name="x64", stt_choice="faster-whisper",
            tts_choice="kokoro-onnx",
            availability={"faster-whisper": True, "kokoro-onnx": True},
            factories={"faster-whisper": lambda: FasterWhisperBackend(
                model_id=str(model_id or self.model_dir), allowed_audio_root=self.root,
                device="cpu", compute_type="int8", model_factory=factory or model_factory)},
        )

    def dispatch(self, registry, language="en", audio=None):
        with patch.object(server, "backend_registry", registry):
            return server.dispatch("stt.transcribe", {
                "audioPath": str(self.audio if audio is None else audio), "language": language,
            })

    def test_input_errors_precede_local_resource_and_model_operations(self):
        from native.python.voice_runtime.backends.base import BackendInputError
        invalid = self.root / "invalid.wav"
        invalid.write_bytes(b"not WAV")
        (self.model_dir / "tokenizer.json").unlink()
        with patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}):
            registry = self.registry()
            for audio, language, code in (
                (self.root.parent / "outside.wav", "en", "AUDIO_PATH_OUTSIDE_RUNTIME_TEMP"),
                (self.root / "missing.wav", "en", "AUDIO_FILE_NOT_FOUND"),
                (self.audio, "../../secret", "INVALID_LANGUAGE"),
                (invalid, "zh-TW", "INVALID_WAV"),
            ):
                with self.subTest(code=code), self.assertRaisesRegex(BackendInputError, "^" + code + "$"):
                    self.dispatch(registry, language, audio)
                self.assertTrue(registry.capabilities()["ready"])
                self.assertEqual(self.loads, [])
                self.assertEqual(self.calls, [])
            (self.model_dir / "tokenizer.json").write_text("{}")
            self.assertEqual(self.dispatch(registry)["text"], "Hello world")
            self.assertEqual(len(self.loads), 1)
            with self.assertRaisesRegex(BackendInputError, "^INVALID_WAV$"):
                self.dispatch(registry, audio=invalid)
            self.assertEqual(len(self.loads), 1)
            self.assertEqual(len(self.calls), 1)
            self.assertTrue(registry.capabilities()["ready"])

    def test_model_and_partial_iterator_faults_remain_sticky_without_partial_success(self):
        for phase in ("factory", "transcribe", "iterator"):
            with self.subTest(phase=phase):
                self.loads.clear(); self.calls.clear(); self.events.clear()

                def transcribe(audio, **kwargs):
                    self.calls.append((audio, kwargs))
                    if phase == "transcribe":
                        raise ValueError("private model detail")

                    def segments():
                        from types import SimpleNamespace
                        self.events.append("started")
                        yield SimpleNamespace(text="partial must not escape")
                        self.events.append("failed")
                        raise RuntimeError("private iteration detail")
                    return segments(), None

                def factory(model, **kwargs):
                    from types import SimpleNamespace
                    self.loads.append((model, kwargs))
                    if phase == "factory":
                        raise ValueError("private factory detail")
                    return SimpleNamespace(supported_languages=["en"], transcribe=transcribe)

                registry = self.registry(factory=factory)
                errors = []
                for _ in range(2):
                    with self.assertRaisesRegex(RuntimeError, "^BACKEND_ERROR:stt:faster-whisper$") as caught:
                        self.dispatch(registry)
                    errors.append(caught.exception)
                self.assertIs(errors[0], errors[1])
                self.assertEqual(len(self.loads), 1)
                self.assertEqual(len(self.calls), 0 if phase == "factory" else 1)
                self.assertEqual(self.events, ["started", "failed"] if phase == "iterator" else [])
                self.assertFalse(registry.capabilities()["ready"])
                self.assertNotIn("faster-whisper", registry.capabilities()["sttBackends"])

    def test_nonoffline_repo_id_preserves_development_device_and_exact_kwargs(self):
        from native.python.voice_runtime.backends.faster_whisper import FasterWhisperBackend
        for flags in ({}, {"HF_HUB_OFFLINE": "0", "TRANSFORMERS_OFFLINE": "0"}):
            with self.subTest(flags=flags), patch.dict(os.environ, flags, clear=True):
                loads = []

                def factory(model, **kwargs):
                    loads.append((model, kwargs))
                    return self.model

                backend = FasterWhisperBackend(
                    model_id="org/development-model", allowed_audio_root=self.root,
                    device="cuda", compute_type="float16", model_factory=factory)
                self.assertEqual(loads, [])
                backend.transcribe(str(self.audio))
                backend.transcribe(str(self.audio))
                self.assertEqual(loads, [("org/development-model", {
                    "device": "cuda", "compute_type": "float16",
                })])

    def test_loaded_language_property_overrides_directory_name_without_poisoning_registry(self):
        from native.python.voice_runtime.backends.base import BackendInputError
        test = self
        reads = []

        class EnglishModel:
            @property
            def supported_languages(self):
                reads.append("loaded languages")
                return ["en"]

            transcribe = staticmethod(test.transcribe)

        self.model = EnglishModel()
        with patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}):
            registry = self.registry()
            self.assertEqual(reads, [])
            with self.assertRaisesRegex(BackendInputError, "^UNSUPPORTED_LANGUAGE_FOR_MODEL$"):
                self.dispatch(registry, "zh-TW")
            self.assertEqual(len(self.loads), 1)
            self.assertEqual(self.calls, [])
            self.assertEqual(reads, ["loaded languages"])
            self.assertTrue(registry.capabilities()["ready"])
            self.assertEqual(self.dispatch(registry, "EN-us")["language"], "en")
            self.assertEqual(len(self.loads), 1)
            self.assertEqual(reads, ["loaded languages"] * 2)

    def test_multilingual_local_directory_ending_en_accepts_normalized_zh(self):
        suffix_dir = self.root / "multilingual.en"
        suffix_dir.mkdir()
        (suffix_dir / "tokenizer.json").write_text("{}")
        with patch.dict(os.environ, {"TRANSFORMERS_OFFLINE": "1"}):
            result = self.dispatch(self.registry(suffix_dir), "ZH-tw")
        self.assertEqual(result["language"], "zh")
        self.assertEqual(self.calls[0][1]["language"], "zh")
        self.assertEqual(self.events, ["started", "completed"])

    def test_missing_or_invalid_loaded_languages_are_sticky_backend_faults(self):
        from types import SimpleNamespace
        for value in (None, "en", [], {}, [None], ["en", 1], ["EN"], ["not-a-language"]):
            with self.subTest(value=value):
                self.loads.clear(); self.calls.clear()
                self.model = SimpleNamespace(supported_languages=value, transcribe=self.transcribe)
                self.assert_language_fault(self.registry())
        self.loads.clear()
        self.model = SimpleNamespace(transcribe=self.transcribe)
        self.assert_language_fault(self.registry())

    def assert_language_fault(self, registry):
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, "^BACKEND_ERROR:stt:faster-whisper$") as caught:
                self.dispatch(registry)
            self.assertEqual(server.public_error_payload(caught.exception)["code"], "BACKEND_ERROR")
        self.assertEqual(len(self.loads), 1)
        self.assertEqual(self.calls, [])
        self.assertIsNone(registry.capabilities()["selectedStt"])
        self.assertFalse(registry.capabilities()["ready"])

    def test_offline_or_local_dispatch_consumes_iterator_and_reuses_model(self):
        import numpy as np
        for flags in ({"HF_HUB_OFFLINE": "1"}, {"TRANSFORMERS_OFFLINE": "1"},
                      {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "0"},
                      {"HF_HUB_OFFLINE": "0", "TRANSFORMERS_OFFLINE": "1"},
                      {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}):
            with self.subTest(flags=flags), patch.dict(os.environ, flags, clear=True):
                self.loads.clear(); self.calls.clear(); self.events.clear()
                registry = self.registry()
                self.assertTrue(registry.capabilities()["ready"])
                self.assertEqual(self.loads, [])
                for _ in range(2):
                    self.assertEqual(self.dispatch(registry), {
                        "text": "Hello world", "language": "en",
                        "model": str(self.model_dir), "engine": "faster-whisper",
                    })
                self.assertEqual(self.events, ["started", "completed"] * 2)
                expected = {"device": "cpu", "compute_type": "int8", "local_files_only": True}
                if sys.platform == "win32":  # Windows CPU STT pins 4 threads
                    expected["cpu_threads"] = 4
                self.assertEqual(self.loads, [(str(self.model_dir), expected)])
                self.assertEqual(len(self.calls), 2)
                for samples, kwargs in self.calls:
                    self.assertIsInstance(samples, np.ndarray)
                    self.assertEqual(samples.dtype, np.float32)
                    self.assertTrue(samples.flags.c_contiguous)
                    np.testing.assert_array_equal(samples, np.array(
                        [-1, 0, 0.5, 32767 / 32768], dtype=np.float32))
                    self.assertEqual(kwargs, {"language": "en", "vad_filter": True,
                                              "condition_on_previous_text": False})

    def test_offline_invalid_local_resources_refuse_before_factory_and_stay_failed(self):
        no_tokenizer = self.root / "no-tokenizer"
        no_tokenizer.mkdir()
        directory_tokenizer = self.root / "directory-tokenizer"
        (directory_tokenizer / "tokenizer.json").mkdir(parents=True)
        try:
            rel_model = os.path.relpath(self.model_dir)
        except ValueError:
            rel_model = self.model_dir.name
        for model in ("org/model", rel_model, self.root / "missing", self.audio,
                      no_tokenizer, directory_tokenizer):
            with self.subTest(model=str(model)), patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}):
                registry = self.registry(model)
                for _ in range(2):
                    with self.assertRaisesRegex(BackendUnavailableError, "runtime unavailable"):
                        self.dispatch(registry)
                self.assertIsNone(registry.capabilities()["selectedStt"])
                self.assertFalse(registry.capabilities()["ready"])
                self.assertEqual(self.loads, [])
                self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
