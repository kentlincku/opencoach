"""Windows CPU STT uses a fixed 4 threads (2026-10-08 maintainer benchmark)."""
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

from native.python.voice_runtime.backends import faster_whisper as fw


class FakeModel:
    calls = []

    def __init__(self, model_id, **kwargs):
        FakeModel.calls.append(kwargs)


class WindowsCpuThreadsTest(unittest.TestCase):
    def setUp(self):
        FakeModel.calls = []
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def backend(self):
        return fw.FasterWhisperBackend(model_id="m", allowed_audio_root=__import__("pathlib").Path(self.tmp.name),
                                       model_factory=FakeModel, device="cpu", compute_type="int8")

    def test_windows_cpu_passes_four_threads(self):
        with patch.object(sys, "platform", "win32"):
            self.backend()._get_model()
        self.assertEqual(FakeModel.calls[-1].get("cpu_threads"), 4)
        self.assertEqual(fw.WINDOWS_CPU_THREADS, 4)

    def test_non_windows_does_not_set_threads(self):
        with patch.object(sys, "platform", "darwin"):
            self.backend()._get_model()
        self.assertNotIn("cpu_threads", FakeModel.calls[-1])

    def test_windows_cuda_does_not_set_threads(self):
        b = self.backend()
        b.device = "cuda"
        with patch.object(sys, "platform", "win32"):
            b._get_model()
        self.assertNotIn("cpu_threads", FakeModel.calls[-1])


if __name__ == "__main__":
    unittest.main()
