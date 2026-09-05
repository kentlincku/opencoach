import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAC = ROOT.joinpath("run.command").read_text(encoding="utf-8")
WINDOWS = ROOT.joinpath("run.bat").read_text(encoding="utf-8")
WINDOWS_SETUP = ROOT.joinpath("scripts/setup-windows.ps1").read_text(encoding="utf-8") if ROOT.joinpath("scripts/setup-windows.ps1").exists() else ""


class LauncherContractTest(unittest.TestCase):
    def test_mac_launcher_bootstraps_desktop_and_sets_process_local_defaults(self):
        self.assertIn('PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"', MAC)
        self.assertIn("scripts/setup-macos.sh", MAC)
        self.assertIn('VOICE_RUNTIME_PYTHON="$ROOT/.venv/bin/python"', MAC)
        self.assertIn('VOICE_STT_BACKEND="${VOICE_STT_BACKEND:-auto}"', MAC)
        self.assertIn('VOICE_TTS_BACKEND="${VOICE_TTS_BACKEND:-auto}"', MAC)
        self.assertIn("mlx-community/whisper-large-v3-turbo", MAC)
        self.assertIn("npm start", MAC)
        self.assertNotIn("exec npm start", MAC)
        self.assertNotIn("http.server", MAC)

    def test_windows_launcher_bootstraps_desktop_and_sets_process_local_defaults(self):
        self.assertIn("scripts\\setup-windows.ps1", WINDOWS)
        self.assertIn("-VerifyAssetsOnly", WINDOWS)
        self.assertLess(WINDOWS.index("-VerifyAssetsOnly"), WINDOWS.index(":launch"))
        self.assertIn('set "VOICE_RUNTIME_PYTHON=%CD%\\.venv\\Scripts\\python.exe"', WINDOWS)
        self.assertIn('set "VOICE_STT_BACKEND=auto"', WINDOWS)
        self.assertIn('set "VOICE_TTS_BACKEND=auto"', WINDOWS)
        self.assertIn("VOICE_KOKORO_ONNX_MODEL", WINDOWS)
        self.assertIn("VOICE_KOKORO_ONNX_VOICES", WINDOWS)
        self.assertIn("call npm start", WINDOWS)
        self.assertNotIn("http.server", WINDOWS)

    def test_windows_setup_uses_pinned_kokoro_assets_and_verifies_hashes(self):
        self.assertIn("requirements-windows.txt", WINDOWS_SETUP)
        self.assertIn("kokoro-v1.0.int8.onnx", WINDOWS_SETUP)
        self.assertIn("voices-v1.0.bin", WINDOWS_SETUP)
        self.assertIn("ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c", WINDOWS_SETUP)
        self.assertIn("bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d", WINDOWS_SETUP)
        self.assertIn("Get-FileHash", WINDOWS_SETUP)
        self.assertIn("npm ci --include=dev", WINDOWS_SETUP)


if __name__ == "__main__":
    unittest.main()
