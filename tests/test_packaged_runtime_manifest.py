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


if __name__ == "__main__":
    unittest.main()
