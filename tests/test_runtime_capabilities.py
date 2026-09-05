import json
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("VOICE_RUNTIME_TEMP_DIR", tempfile.gettempdir())

from native.python.voice_runtime import server


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "contracts" / "voice-runtime.schema.json").read_text(encoding="utf-8"))
DESKTOP_MAIN = (ROOT / "apps" / "desktop" / "main.cjs").read_text(encoding="utf-8")
MACOS_SECURITY = (ROOT / "apps" / "desktop" / "macos-runtime-security.cjs").read_text(encoding="utf-8")
SIDECAR_ENVIRONMENT = (ROOT / "apps" / "desktop" / "sidecar-environment.cjs").read_text(encoding="utf-8")


class RuntimeCapabilitiesTest(unittest.TestCase):
    def test_desktop_does_not_coerce_tts_objects_to_strings(self):
        self.assertNotIn("String(payload?.text", DESKTOP_MAIN)
        self.assertIn("typeof payload?.text !== 'string'", DESKTOP_MAIN)

    def test_desktop_uses_full_environment_only_in_development(self):
        self.assertIn("if (app.isPackaged)", DESKTOP_MAIN)
        self.assertIn("buildPackagedRuntimeEnvironment", DESKTOP_MAIN)
        self.assertIn("return { ...process.env, VOICE_RUNTIME_TEMP_DIR: tempRoot }", DESKTOP_MAIN)
        self.assertIn("SYSTEM_ENV_ALLOWLIST", MACOS_SECURITY)
        self.assertNotIn("VOICE_RUNTIME_DEBUG", MACOS_SECURITY)
        self.assertNotIn("VOICE_RUNTIME_FAKE", MACOS_SECURITY)
        self.assertNotIn("NODE_OPTIONS", MACOS_SECURITY)

    def test_packaged_desktop_admits_only_verified_backend_configuration(self):
        for name in (
            "VOICE_STT_BACKEND",
            "VOICE_TTS_BACKEND",
            "VOICE_FASTER_WHISPER_MODEL",
            "VOICE_FASTER_WHISPER_DEVICE",
            "VOICE_FASTER_WHISPER_COMPUTE_TYPE",
            "VOICE_KOKORO_ONNX_MODEL",
            "VOICE_KOKORO_ONNX_VOICES",
        ):
            self.assertIn(f"'{name}'", SIDECAR_ENVIRONMENT)
        for forbidden in ("VOICE_RUNTIME_DEBUG", "VOICE_RUNTIME_FAKE", "VOICE_MLX_WHISPER_MODEL"):
            self.assertNotIn(f"'{forbidden}'", SIDECAR_ENVIRONMENT)

    def test_apple_silicon_reports_native_backends_ready(self):
        result = server.health_capabilities("darwin", "arm64", availability={
            "mlx-whisper": True,
            "faster-whisper": True,
            "kokoro-python": True,
            "kokoro-onnx": True,
        })

        self.assertEqual(result["sttBackends"], ["mlx-whisper", "faster-whisper"])
        self.assertEqual(result["ttsBackends"], ["kokoro-python", "kokoro-onnx"])
        self.assertEqual(result["selectedStt"], "mlx-whisper")
        self.assertEqual(result["selectedTts"], "kokoro-python")
        self.assertIs(result["ready"], True)
        self.assertIsNone(result["degradedReason"])

    def test_missing_dependencies_do_not_advertise_native_backends(self):
        result = server.health_capabilities("linux", "x64", availability={})

        self.assertEqual(result["sttBackends"], [])
        self.assertEqual(result["ttsBackends"], [])
        self.assertIsNone(result["selectedStt"])
        self.assertIsNone(result["selectedTts"])
        self.assertIs(result["ready"], False)
        self.assertEqual(result["degradedReason"], "BACKEND_UNAVAILABLE")

    def test_linux_selects_cross_platform_backends_when_available(self):
        result = server.health_capabilities("linux", "x64", availability={
            "mlx-whisper": True,
            "faster-whisper": True,
            "kokoro-python": False,
            "kokoro-onnx": True,
        })

        self.assertEqual(result["sttBackends"], ["faster-whisper"])
        self.assertEqual(result["ttsBackends"], ["kokoro-onnx"])
        self.assertEqual(result["selectedStt"], "faster-whisper")
        self.assertEqual(result["selectedTts"], "kokoro-onnx")
        self.assertTrue(result["ready"])

    def test_health_payload_matches_declared_schema_fields(self):
        result = server.health_capabilities("darwin", "arm64", availability={
            "mlx-whisper": True,
            "kokoro-python": True,
        })

        self.assertTrue(set(SCHEMA["required"]).issubset(result))
        self.assertTrue(set(result).issubset(SCHEMA["properties"]))
        self.assertFalse(SCHEMA["additionalProperties"])


if __name__ == "__main__":
    unittest.main()
