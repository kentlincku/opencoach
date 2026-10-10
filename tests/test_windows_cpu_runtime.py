"""Windows W1 CPU runtime policy: no CUDA payload may reach a CPU runtime tree.

Pure tests; no build, no PyInstaller, no Windows host required.
"""
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


policy = load('win_cpu_runtime_policy', 'scripts/win_cpu_runtime_policy.py')


class CpuRuntimePolicyTests(unittest.TestCase):
    def test_previously_leaked_toolkit_dlls_are_refused_case_insensitively(self):
        tree = ['bin/voice-runtime.exe', 'bin/_internal/cublas64_13.dll', 'bin/_internal/CUBLASLT64_13.DLL',
                'bin/_internal/ctranslate2/cudnn64_9.dll', 'bin/_internal/nvrtc64_120_0.dll',
                'bin/_internal/onnxruntime/capi/onnxruntime_providers_cuda.dll',
                'bin/_internal/onnxruntime/capi/onnxruntime_providers_tensorrt.dll']
        with self.assertRaisesRegex(ValueError, 'WIN_CPU_RUNTIME_CUDA_PAYLOAD'):
            policy.receipt_gate(tree)
        self.assertEqual(len(policy.forbidden_cuda_files(tree)), 6)

    def test_clean_cpu_tree_passes_and_keeps_cpu_ort_and_ct2(self):
        tree = ['bin/voice-runtime.exe', 'bin/_internal/onnxruntime/capi/onnxruntime.dll',
                'bin/_internal/onnxruntime/capi/onnxruntime_providers_shared.dll',
                'bin/_internal/ctranslate2/ctranslate2.dll', 'bin/_internal/ctranslate2/libiomp5md.dll',
                'bin/_internal/cuda_notes_readme.txt']
        self.assertEqual(policy.receipt_gate(tree)['cudaPayload'], [])

    def test_gpu_distributions_and_wrong_pins_are_refused(self):
        good = {'onnxruntime': '1.30.0', 'ctranslate2': '4.8.2', 'faster_whisper': '1.2.1', 'spacy': '3.8.16'}
        self.assertTrue(policy.check_distributions(good))
        for extra in ({'onnxruntime-gpu': '1.30.0'}, {'nvidia-cublas-cu12': '12.9'}, {'nvidia_cudnn_cu12': '9'}):
            with self.assertRaisesRegex(ValueError, 'GPU_DISTRIBUTION'):
                policy.check_distributions({**good, **extra})
        with self.assertRaisesRegex(ValueError, 'PIN'):
            policy.check_distributions({**good, 'onnxruntime': '1.22.1'})

    def test_build_path_excludes_cuda_toolkit(self):
        path = policy.sanitized_build_path('C:\\WINDOWS')
        self.assertEqual(path, 'C:\\WINDOWS\\System32;C:\\WINDOWS')
        self.assertNotIn('NVIDIA', path)
        for bad in ('', 'C:\\WINDOWS;C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.3\\bin', '/usr'):
            with self.assertRaises(ValueError):
                policy.sanitized_build_path(bad)

    def test_wheel_bundled_cudnn_is_dropped_from_the_freeze_toc(self):
        toc = [('ctranslate2\\cudnn64_9.dll', 'x', 'BINARY'), ('ctranslate2\\ctranslate2.dll', 'y', 'BINARY'),
               ('cublasLt64_13.dll', 'z', 'BINARY')]
        kept, dropped = policy.filter_binaries(toc)
        self.assertEqual([k[0] for k in kept], ['ctranslate2\\ctranslate2.dll'])
        self.assertEqual(dropped, ['ctranslate2/cudnn64_9.dll', 'cublasLt64_13.dll'])


class CpuBuilderWiringTests(unittest.TestCase):
    """Source-level: the CPU builder and spec actually call the policy on the build path."""
    def test_cpu_builder_uses_policy_gate_path_and_cpu_spec(self):
        src = (ROOT / 'scripts/win-build-local-runtime-cpu.py').read_text(encoding='utf-8')
        for needle in ('check_distributions(', 'sanitized_build_path(', 'receipt_gate(', 'win-local-cpu.spec',
                       "'cudaPayload'", 'WIN_CPU_LOCAL_SINGLE_MACHINE_NOT_RELEASE'):
            self.assertIn(needle, src)
        self.assertNotIn("distribution('onnxruntime-gpu')", src)
        self.assertNotIn("'nvidia' /", src)
        spec = (ROOT / 'spikes/packaged-runtime/win-local-cpu.spec').read_text(encoding='utf-8')
        self.assertIn('filter_binaries(', spec)
        self.assertNotIn("cfg['binaries']", spec)

    def test_legacy_bundled_builder_is_unchanged_in_role(self):
        src = (ROOT / 'scripts/win-build-local-runtime.py').read_text(encoding='utf-8')
        self.assertIn("metadata.distribution('onnxruntime-gpu')", src)


if __name__ == '__main__':
    unittest.main()
