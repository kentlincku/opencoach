import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).parents[1]


class PackagedRuntimeBuildTests(unittest.TestCase):
    def test_build_script_uses_supported_native_platform_keys(self):
        script = ROOT / "spikes/packaged-runtime/build-runtime.py"
        spec = importlib.util.spec_from_file_location("build_runtime", script)
        if spec is None or spec.loader is None:
            self.fail("build script could not be loaded")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.platform_key("Darwin", "arm64"), "darwin-arm64")
        self.assertEqual(module.platform_key("Windows", "AMD64"), "win32-x64-cpu")
        with self.assertRaises(ValueError):
            module.platform_key("Linux", "x86_64")

    def test_requirements_lock_and_pinned_inputs_contract(self):
        lock_file = ROOT / "spikes/packaged-runtime/requirements-macos-arm64.lock.txt"
        self.assertTrue(lock_file.is_file(), "requirements-macos-arm64.lock.txt must exist")
        lock_content = lock_file.read_text(encoding="utf-8")
        self.assertIn("--hash=sha256:", lock_content, "Lockfile must contain sha256 hashes")
        self.assertIn("en-core-web-sm @ https://", lock_content, "Lockfile must pin spaCy model source")

        req_in = ROOT / "spikes/packaged-runtime/requirements.in"
        self.assertTrue(req_in.is_file(), "requirements.in must exist")
        in_content = req_in.read_text(encoding="utf-8")
        for line in in_content.strip().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            self.assertTrue(
                "==" in line or "@ https://" in line,
                f"Direct dependency in requirements.in must be exact pinned (== or @ url): {line}"
            )

        req_txt = ROOT / "spikes/packaged-runtime/requirements.txt"
        self.assertFalse(req_txt.is_file(), "Floating requirements.txt must be replaced/removed")

        # Parse complete lockfile: require 104 entries, require hashes, reject local/floating/credentials
        lines = lock_content.splitlines()
        entries = []
        current_entry = None
        current_hashes = []
        for raw_line in lines:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("--hash="):
                self.assertIsNotNone(current_entry, "Hash must belong to a package entry")
                current_hashes.append(line)
            elif not line.startswith("\\"):
                if current_entry:
                    entries.append((current_entry, current_hashes))
                current_entry = line.rstrip(" \\")
                current_hashes = []
        if current_entry:
            entries.append((current_entry, current_hashes))

        self.assertEqual(len(entries), 104, f"Expected exactly 104 locked package entries, found {len(entries)}")
        for pkg, hashes in entries:
            self.assertGreater(len(hashes), 0, f"Package {pkg} must have at least one sha256 hash")
            self.assertFalse(pkg.startswith("-e "), f"Editable packages forbidden in lockfile: {pkg}")
            self.assertNotIn("file:", pkg, f"Local path forbidden in lockfile: {pkg}")
            self.assertNotIn("git+", pkg, f"Floating VCS refs forbidden in lockfile: {pkg}")
            self.assertNotIn("@ main", pkg, f"Floating branch refs forbidden: {pkg}")
            self.assertNotIn("@ master", pkg, f"Floating branch refs forbidden: {pkg}")
            # Ensure no credentials in URL
            if "@ https://" in pkg:
                url_part = pkg.split("@ https://", 1)[1]
                self.assertNotIn("@", url_part.split("/")[0], f"Credential-bearing URLs forbidden: {pkg}")

    def test_build_script_uses_uv_pip_sync_and_forbids_dynamic_spacy_download(self):
        build_sh = ROOT / "scripts/build-macos-runtime.sh"
        self.assertTrue(build_sh.is_file())
        content = build_sh.read_text(encoding="utf-8")
        self.assertNotIn("python3 -m spacy download", content, "Dynamic spacy download is strictly forbidden")
        self.assertNotIn("python -m spacy download", content, "Dynamic spacy download is strictly forbidden")
        self.assertNotIn("pip install --upgrade", content, "Floating pip install is strictly forbidden")
        self.assertIn("uv pip sync", content, "Build script must use uv pip sync")
        self.assertIn("--require-hashes", content, "Build script must require hashes")

    def test_build_script_fails_if_metallib_missing_when_mlx_selected(self):
        build_sh = ROOT / "scripts/build-macos-runtime.sh"
        self.assertTrue(build_sh.is_file())
        content = build_sh.read_text(encoding="utf-8")
        self.assertIn("dist/voice-runtime/_internal/mlx", content)
        self.assertIn("Required mlx.metallib for MLX Metal acceleration missing from build output", content)
        self.assertIn("exit 1", content)

    def test_windows_runtime_inputs_locked_with_hashes(self):
        in_file = ROOT / "spikes/packaged-runtime/requirements-windows-x64.in"
        lock_file = ROOT / "spikes/packaged-runtime/requirements-windows-x64.lock.txt"
        self.assertTrue(in_file.is_file(), "requirements-windows-x64.in must exist")
        self.assertTrue(lock_file.is_file(), "requirements-windows-x64.lock.txt must exist")

        lines = lock_file.read_text(encoding="utf-8").splitlines()
        packages = [line.strip().split("==")[0] for line in lines if "==" in line and not line.strip().startswith("#")]
        self.assertIn("onnxruntime", packages)
        self.assertIn("misaki", packages)
        self.assertIn("soundfile", packages)
        self.assertIn("pyinstaller", packages)
        self.assertNotIn("kokoro-onnx", packages, "kokoro-onnx must be excluded to prevent GPL dependencies")
        self.assertNotIn("av", packages, "PyAV must be excluded to prevent GPL codec dependencies")

        # Must have sha256 hashes
        hashes = [line.strip() for line in lines if "--hash=sha256:" in line]
        self.assertTrue(len(hashes) > 0, "requirements-windows-x64.lock.txt must contain sha256 hashes")

    def test_windows_runtime_inputs_reject_mutually_exclusive_onnxruntime(self):
        lock_file = ROOT / "spikes/packaged-runtime/requirements-windows-x64.lock.txt"
        if not lock_file.is_file():
            return
        lines = lock_file.read_text(encoding="utf-8").splitlines()
        has_cpu = any(line.strip().startswith("onnxruntime==") for line in lines)
        has_dml = any(line.strip().startswith("onnxruntime-directml==") for line in lines)
        self.assertFalse(
            has_cpu and has_dml,
            "Cannot simultaneously install mutually exclusive onnxruntime and onnxruntime-directml",
        )

    def test_windows_runtime_scripts_exist(self):
        build_script = ROOT / "scripts/build-windows-runtime.ps1"
        check_script = ROOT / "scripts/check-windows-runtime.mjs"
        self.assertTrue(build_script.is_file(), "scripts/build-windows-runtime.ps1 must exist")
        self.assertTrue(check_script.is_file(), "scripts/check-windows-runtime.mjs must exist")


if __name__ == "__main__":
    unittest.main()
