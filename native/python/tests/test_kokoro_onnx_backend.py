from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from native.python.voice_runtime.backends.base import (
    BackendExecutionError,
    BackendInputError,
    BackendUnavailableError,
)
from native.python.voice_runtime.backends.kokoro_onnx import KokoroOnnxBackend


class FakeSession:
    def __init__(self, providers: list[str]) -> None:
        self._providers = list(providers)

    def get_providers(self) -> list[str]:
        return list(self._providers)


class FakeKokoroEngine:
    def __init__(self, providers: list[str] | None = None) -> None:
        self.sess = FakeSession(providers or ["CPUExecutionProvider"])

    def create(self, text: str, voice: str = "af_heart", speed: float = 1.0, lang: str = "en-us"):
        # Returns simple waveform (500 samples) at 24000 Hz
        return [0.0] * 500, 24000


class TestKokoroOnnxBackend(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.model_path = Path(self.temp_dir.name) / "kokoro-v1.0.onnx"
        self.voices_path = Path(self.temp_dir.name) / "voices-v1.0.bin"
        self.model_path.write_bytes(b"dummy onnx model content")
        self.voices_path.write_bytes(b"dummy voices bin content")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_provider_selection_directml_success(self) -> None:
        """When DirectML is requested and available, executionProvider reports DmlExecutionProvider."""
        engine = FakeKokoroEngine(providers=["DmlExecutionProvider", "CPUExecutionProvider"])
        backend = KokoroOnnxBackend(
            model_path=self.model_path,
            voices_path=self.voices_path,
            requested_provider="directml",
            engine_factory=lambda *_: engine,
        )
        self.assertEqual(backend.execution_provider, "DmlExecutionProvider")
        res = backend.synthesize("Hello world", "af_heart", 1.0)
        self.assertEqual(res["engine"], "kokoro-onnx")
        self.assertEqual(res["executionProvider"], "DmlExecutionProvider")
        # Ensure no model absolute path in synthesis result
        self.assertNotIn(str(self.model_path), str(res))

    def test_provider_selection_directml_fails_closed_when_dml_missing(self) -> None:
        """When DirectML is requested but session only has CPUExecutionProvider, fail closed."""
        engine = FakeKokoroEngine(providers=["CPUExecutionProvider"])
        backend = KokoroOnnxBackend(
            model_path=self.model_path,
            voices_path=self.voices_path,
            requested_provider="directml",
            engine_factory=lambda *_: engine,
        )
        with self.assertRaises(BackendUnavailableError):
            backend.synthesize("Hello", "af_heart", 1.0)

    def test_engine_resident_and_factory_called_once_for_20_syntheses(self) -> None:
        """Engine factory must only be called once across 20 consecutive synthesize calls (persistent session)."""
        call_count = 0

        def factory(*_):
            nonlocal call_count
            call_count += 1
            return FakeKokoroEngine()

        backend = KokoroOnnxBackend(
            model_path=self.model_path,
            voices_path=self.voices_path,
            requested_provider="cpu",
            engine_factory=factory,
        )

        for i in range(20):
            res = backend.synthesize(f"Sentence number {i}", "af_heart", 1.0)
            self.assertEqual(res["executionProvider"], "CPUExecutionProvider")

        self.assertEqual(call_count, 1, "Engine factory must be called exactly once across 20 syntheses")

    def test_failure_boundaries_typed_errors(self) -> None:
        """Failure boundaries: missing assets, invalid voice/speed/text, engine crash."""
        # Missing model
        missing_model = Path(self.temp_dir.name) / "non_existent.onnx"
        with self.assertRaises(BackendUnavailableError):
            KokoroOnnxBackend(model_path=missing_model, voices_path=self.voices_path)

        # Invalid text length
        backend = KokoroOnnxBackend(
            model_path=self.model_path,
            voices_path=self.voices_path,
            engine_factory=lambda *_: FakeKokoroEngine(),
        )
        with self.assertRaises(BackendInputError):
            backend.synthesize("", "af_heart", 1.0)
        with self.assertRaises(BackendInputError):
            backend.synthesize("x" * 5001, "af_heart", 1.0)

        # Invalid speed
        with self.assertRaises(BackendInputError):
            backend.synthesize("Valid text", "af_heart", 0.1)
        with self.assertRaises(BackendInputError):
            backend.synthesize("Valid text", "af_heart", 5.0)

        # Engine exception wraps into BackendExecutionError
        broken_engine = MagicMock()
        broken_engine.create.side_effect = RuntimeError("Kernel crash")
        broken_engine.sess.get_providers.return_value = ["CPUExecutionProvider"]
        broken_backend = KokoroOnnxBackend(
            model_path=self.model_path,
            voices_path=self.voices_path,
            engine_factory=lambda *_: broken_engine,
        )
        with self.assertRaises(BackendExecutionError):
            broken_backend.synthesize("Test", "af_heart", 1.0)


if __name__ == "__main__":
    unittest.main()
