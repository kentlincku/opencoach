import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WINDOWS_SETUP = ROOT.joinpath("scripts/setup-windows.ps1").read_text(encoding="utf-8") if ROOT.joinpath("scripts/setup-windows.ps1").exists() else ""


class WindowsSetupContractTest(unittest.TestCase):
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
