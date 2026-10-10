"""Mac package slimming policy (no build; pure tests).

- numba/scipy stubs keep `import mlx_whisper` working and fail loudly on use.
- the r56 local spec excludes scipy and numba, and the darwin entry installs the stubs first.
- the r56 runtime build keeps exactly one mlx.metallib/libmlx.dylib (the top-level ones).
- electron-builder keeps only the English and Traditional Chinese Electron locales.
"""
import importlib.util
import re
import subprocess
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPIKE = ROOT / 'spikes/packaged-runtime'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stubs = load('packaged_stubs_under_test', SPIKE / 'packaged_stubs.py')


class StubTests(unittest.TestCase):
    def test_stubs_satisfy_mlx_whisper_timing_imports_and_fail_loudly_on_use(self):
        modules = {}
        stubs.install(modules)
        numba, scipy, signal = modules['numba'], modules['scipy'], modules['scipy.signal']
        self.assertIs(scipy.signal, signal)
        self.assertEqual(list(numba.prange(3)), [0, 1, 2])
        jitted = numba.jit(nopython=True)(lambda x: x)
        with self.assertRaisesRegex(RuntimeError, '^NUMBA_UNAVAILABLE_IN_PACKAGED_RUNTIME$'):
            jitted(1)
        with self.assertRaisesRegex(RuntimeError, '^SCIPY_UNAVAILABLE_IN_PACKAGED_RUNTIME$'):
            signal.medfilt([1.0], kernel_size=1)
        with self.assertRaisesRegex(RuntimeError, '^SCIPY_UNAVAILABLE_IN_PACKAGED_RUNTIME$'):
            scipy.stats  # noqa: B018 - any other scipy use must not silently succeed

    def test_stubs_never_replace_a_real_module(self):
        real = types.ModuleType('scipy')
        modules = {'scipy': real}
        stubs.install(modules)
        self.assertIs(modules['scipy'], real)

    def test_from_scipy_import_signal_resolves_to_the_stub_in_a_fresh_interpreter(self):
        code = ('import sys; sys.path.insert(0, %r); import packaged_stubs; packaged_stubs.install();'
                'from scipy import signal; import numba;'
                'print(signal.__name__, type(numba).__name__)') % str(SPIKE)
        out = subprocess.run([sys.executable, '-I', '-c', code], capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.strip(), 'scipy.signal module')

    def test_find_spec_on_the_stubs_does_not_raise(self):
        code = ('import sys, importlib.util; sys.path.insert(0, %r); import packaged_stubs; packaged_stubs.install();'
                'print(importlib.util.find_spec("scipy") is not None, importlib.util.find_spec("numba") is not None)') % str(SPIKE)
        out = subprocess.run([sys.executable, '-I', '-c', code], capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.strip(), 'True True')


class PackagingPolicyTests(unittest.TestCase):
    def test_darwin_entry_installs_stubs_before_the_server_import(self):
        entry = (SPIKE / 'darwin-entry.py').read_text()
        install = entry.index('packaged_stubs.install()')
        self.assertLess(install, entry.index('from voice_runtime.server import serve'))
        self.assertNotIn("types.ModuleType('numba')", entry, 'one stub implementation only')

    def test_r56_local_spec_excludes_scipy_and_numba_and_bundles_the_stubs(self):
        spec = (SPIKE / 'r56-local.spec').read_text()
        excludes = re.search(r"^excludes = .*$", spec, re.M).group(0)
        for name in ('numba', 'llvmlite', 'scipy'):
            self.assertIn(repr(name), excludes)
        self.assertIn("'packaged_stubs'", spec)

    def test_r56_build_keeps_one_metal_library_and_drops_scipy_blas(self):
        build = (ROOT / 'scripts/r56-build-local-runtime.py').read_text()
        self.assertNotIn("shutil.copy2(internal / 'mlx/lib/mlx.metallib', internal / 'mlx.metallib')", build)
        for name in ('mlx.metallib', 'libmlx.dylib'):
            self.assertIn(name, build)
        self.assertIn('DUPLICATE_MLX_LIBRARY', build)
        self.assertIn('libscipy_openblas.dylib', build)
        self.assertIn('SCIPY_IN_RUNTIME', build)
        self.assertIn('MLX_LIBRARY_LAYOUT', build)
        self.assertIn("EXCLUDED_DISTRIBUTIONS = {'scipy', 'numba', 'llvmlite'}", build)

    def test_electron_builder_keeps_only_en_and_zh_tw_locales(self):
        config = (ROOT / 'electron-builder.yml').read_text()
        block = re.search(r'^electronLanguages:\n((?:  - .*\n)+)', config, re.M)
        self.assertIsNotNone(block, 'electronLanguages must be set at the top level')
        self.assertEqual(sorted(re.findall(r'- (\S+)', block.group(1))), ['en', 'zh_TW'])


if __name__ == '__main__':
    unittest.main()
