"""CUDA-first / CPU-fallback policy. No GPU, DLL or vendor needed: every
boundary (platform, DLL loader, device count, ORT providers, model factory) is doubled."""
import os
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from native.python.voice_runtime import accelerator
from native.python.voice_runtime.backends.base import BackendUnavailableError


def ok_loader(name):
    return SimpleNamespace(name=name)


def missing_cudnn(name):
    if Path(name).name.startswith('cudnn'):
        raise OSError('Could not find module ' + name)
    return SimpleNamespace(name=name)


def fake_nvidia(root, skip=()):
    dirs = []
    for lib, name in accelerator.WINDOWS_CUDA_DLLS:
        d = Path(root) / 'nvidia' / lib / 'bin'
        d.mkdir(parents=True, exist_ok=True)
        if name not in skip:
            (d / name).write_bytes(b'dll')
        if d not in dirs:
            dirs.append(d)
    return dirs


class PolicyTest(unittest.TestCase):
    def setUp(self):
        accelerator.reset_for_tests()
        self.addCleanup(accelerator.reset_for_tests)
        self.enterContext(patch.object(accelerator, '_register_dll_dirs', lambda dirs: None))
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dirs = fake_nvidia(tmp.name)

    def env(self, value):
        values = {} if value is None else {'VOICE_ACCELERATOR': value}
        ctx = patch.dict(os.environ, values)
        self.enterContext(ctx)
        if value is None:
            os.environ.pop('VOICE_ACCELERATOR', None)

    def test_policy_values(self):
        for value, expected in [(None, 'auto'), ('', 'auto'), ('AUTO', 'auto'), ('cpu', 'cpu'), (' cuda ', 'cuda')]:
            with self.subTest(value=value), patch.dict(os.environ, {}, clear=False):
                os.environ.pop('VOICE_ACCELERATOR', None)
                if value is not None:
                    os.environ['VOICE_ACCELERATOR'] = value
                self.assertEqual(accelerator.policy(), expected)
        with patch.dict(os.environ, {'VOICE_ACCELERATOR': 'dml'}), self.assertRaises(BackendUnavailableError):
            accelerator.policy()

    def test_frozen_unset_defaults_to_cpu_explicit_wins(self):
        with patch.dict(os.environ, {}), patch.object(accelerator.sys, 'frozen', True, create=True):
            os.environ.pop('VOICE_ACCELERATOR', None)
            self.assertEqual(accelerator.policy(), 'cpu')
            probe = Mock()
            with patch.object(accelerator, 'probe', probe):
                self.assertFalse(accelerator.use_cuda('stt'))
            probe.assert_not_called()
            for explicit in ('auto', 'cuda'):
                os.environ['VOICE_ACCELERATOR'] = explicit
                self.assertEqual(accelerator.policy(), explicit)

    def test_dlls_loaded_by_full_path_from_nvidia_dirs_only(self):
        loaded = []
        loader = lambda name: loaded.append(name) or SimpleNamespace()
        self.assertEqual(accelerator.probe('stt', platform_name='win32', loader=loader, device_count=lambda: 1,
                                           dll_dirs=self.dirs), (True, ''))
        expected = [str(d / n) for d in self.dirs for lib, n in accelerator.WINDOWS_CUDA_DLLS if d.parent.name == lib]
        self.assertEqual(sorted(loaded), sorted(expected))
        self.assertTrue(all(Path(p).is_absolute() for p in loaded))

    def test_dll_absent_from_wheel_dir_is_missing_without_bare_name_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            dirs = fake_nvidia(tmp, skip=('cudnn_graph64_9.dll',))
            loader = Mock()
            self.assertEqual(accelerator.probe('stt', platform_name='win32', loader=loader, device_count=lambda: 1,
                                               dll_dirs=dirs), (False, 'CUDA_DLL_MISSING:cudnn_graph64_9.dll'))
            loader.assert_not_called()
        self.assertEqual(accelerator.probe('stt', platform_name='win32', loader=Mock(), device_count=lambda: 1,
                                           dll_dirs=[]), (False, 'CUDA_DLL_MISSING:cublas64_12.dll'))

    def test_frozen_search_scope_is_runtime_internal_only(self):
        exe = os.path.join(os.sep, 'app', 'runtime', 'bin', 'voice-runtime.exe')
        with patch.object(accelerator.sys, 'frozen', True, create=True), \
                patch.object(accelerator.sys, 'executable', exe), \
                patch.object(accelerator.site, 'getsitepackages', return_value=['/elsewhere']):
            self.assertEqual(accelerator._site_packages(),
                             [str(accelerator.Path(exe).absolute().parent / '_internal')])

    def test_search_scope_is_site_packages(self):
        with patch.object(accelerator.site, 'getsitepackages', return_value=['/a']), \
                patch.object(accelerator.site, 'getusersitepackages', return_value='/u'), \
                patch.object(accelerator.sys, 'path', ['/pythonpath', '/a']):
            self.assertEqual(accelerator._site_packages(), ['/a', '/u'])

    def test_probe_cuda_present(self):
        self.assertEqual(accelerator.probe('stt', platform_name='win32', loader=ok_loader, dll_dirs=self.dirs, device_count=lambda: 1), (True, ''))
        self.assertEqual(accelerator.probe('tts', platform_name='win32', loader=ok_loader, dll_dirs=self.dirs,
                                           ort_providers=lambda: ['CUDAExecutionProvider', 'CPUExecutionProvider']), (True, ''))

    def test_probe_failures_are_reasons_not_exceptions(self):
        cases = [
            (dict(kind='stt', platform_name='darwin'), 'CUDA_UNSUPPORTED_PLATFORM'),
            (dict(kind='stt', platform_name='win32', loader=missing_cudnn, dll_dirs=self.dirs, device_count=lambda: 1), 'CUDA_DLL_MISSING:cudnn64_9.dll'),
            (dict(kind='stt', platform_name='win32', loader=ok_loader, dll_dirs=self.dirs, device_count=lambda: 0), 'CUDA_NO_DEVICE'),
            # CPU onnxruntime installed over onnxruntime-gpu
            (dict(kind='tts', platform_name='win32', loader=ok_loader, dll_dirs=self.dirs,
                  ort_providers=lambda: ['AzureExecutionProvider', 'CPUExecutionProvider']), 'CUDA_PROVIDER_MISSING'),
            (dict(kind='stt', platform_name='win32', loader=ok_loader, dll_dirs=self.dirs,
                  device_count=Mock(side_effect=RuntimeError('driver'))), 'CUDA_PROBE_FAILED'),
        ]
        for kwargs, reason in cases:
            with self.subTest(reason=reason):
                kind = kwargs.pop('kind')
                self.assertEqual(accelerator.probe(kind, **kwargs), (False, reason))

    def test_use_cuda_policy(self):
        good = dict(platform_name='win32', loader=ok_loader, dll_dirs=self.dirs, device_count=lambda: 1)
        bad = dict(platform_name='win32', loader=missing_cudnn, dll_dirs=self.dirs, device_count=lambda: 1)
        with patch.dict(os.environ, {'VOICE_ACCELERATOR': 'auto'}):
            self.assertTrue(accelerator.use_cuda('stt', **good))
            self.assertFalse(accelerator.use_cuda('stt', **bad))
        with patch.dict(os.environ, {'VOICE_ACCELERATOR': 'cpu'}):
            probe = Mock()
            with patch.object(accelerator, 'probe', probe):
                self.assertFalse(accelerator.use_cuda('stt'))
            probe.assert_not_called()
        with patch.dict(os.environ, {'VOICE_ACCELERATOR': 'cuda'}):
            self.assertTrue(accelerator.use_cuda('stt', **good))
            # Required CUDA but the environment lacks it: refuse, never silently CPU.
            with self.assertRaisesRegex(BackendUnavailableError, 'CUDA_REQUIRED:CUDA_DLL_MISSING'):
                accelerator.use_cuda('stt', **bad)

    def test_nvidia_dll_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            for lib in ('cublas', 'cudnn'):
                (Path(tmp) / 'nvidia' / lib / 'bin').mkdir(parents=True)
            (Path(tmp) / 'nvidia' / 'other' / 'bin').mkdir(parents=True)
            found = accelerator.nvidia_dll_dirs([tmp, '', tmp])
            self.assertEqual(found, [Path(tmp) / 'nvidia' / 'cublas' / 'bin', Path(tmp) / 'nvidia' / 'cudnn' / 'bin'])


class FasterWhisperPlacementTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.audio = self.root / 'a.wav'
        with wave.open(str(self.audio), 'wb') as w:
            w.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            w.writeframes(b'\x00\x00\x00\x40')
        for name in ('VOICE_FASTER_WHISPER_DEVICE', 'VOICE_FASTER_WHISPER_COMPUTE_TYPE'):
            self.enterContext(patch.dict(os.environ, {}))
            os.environ.pop(name, None)
        self.enterContext(patch('sys.platform', 'win32'))

    def backend(self, factory, **kwargs):
        from native.python.voice_runtime.backends.faster_whisper import FasterWhisperBackend
        return FasterWhisperBackend(model_id='base.en', allowed_audio_root=self.root, model_factory=factory, **kwargs)

    def model(self):
        return SimpleNamespace(supported_languages=['en'], transcribe=lambda *a, **k: ([SimpleNamespace(text='ok')], None))

    def test_cuda_first(self):
        loads = []
        factory = lambda model_id, **kw: loads.append(kw) or self.model()
        with patch.dict(os.environ, {'VOICE_ACCELERATOR': 'auto'}), patch.object(accelerator, 'use_cuda', return_value=True):
            b = self.backend(factory)
            b.transcribe(str(self.audio))
        self.assertEqual(loads, [{'device': 'cuda', 'compute_type': 'float16'}])
        self.assertEqual(b.placement, ('cuda', 'float16'))

    def test_cuda_load_error_falls_back_to_cpu_in_auto(self):
        loads = []
        def factory(model_id, **kw):
            loads.append(kw)
            if kw['device'] == 'cuda':
                raise RuntimeError('CUDA failed with error out of memory')
            return self.model()
        with patch.dict(os.environ, {'VOICE_ACCELERATOR': 'auto'}), patch.object(accelerator, 'use_cuda', return_value=True):
            b = self.backend(factory)
            self.assertEqual(b.transcribe(str(self.audio))['text'], 'ok')
        cpu = {'device': 'cpu', 'compute_type': 'int8'}
        if sys.platform == 'win32':  # Windows CPU STT pins 4 threads
            cpu['cpu_threads'] = 4
        self.assertEqual(loads, [{'device': 'cuda', 'compute_type': 'float16'}, cpu])
        self.assertEqual(b.placement, ('cpu', 'int8'))

    def test_required_cuda_load_error_is_backend_unavailable(self):
        factory = Mock(side_effect=RuntimeError('CUDA failed'))
        with patch.dict(os.environ, {'VOICE_ACCELERATOR': 'cuda'}), patch.object(accelerator, 'use_cuda', return_value=True):
            with self.assertRaisesRegex(BackendUnavailableError, 'CUDA_REQUIRED:CUDA_LOAD_FAILED'):
                self.backend(factory).transcribe(str(self.audio))
        self.assertEqual(factory.call_count, 1)

    def test_explicit_auto_device_is_passed_through_without_policy(self):
        # Documented: explicit "auto" is the caller's choice (contract in test_wav_decoder).
        loads = []
        factory = lambda model_id, **kw: loads.append(kw) or self.model()
        use = Mock()
        with patch.object(accelerator, 'use_cuda', use):
            self.backend(factory, device='auto').transcribe(str(self.audio))
        use.assert_not_called()
        self.assertEqual(loads, [{'device': 'auto', 'compute_type': 'int8'}])

class OnnxSessionTest(unittest.TestCase):
    def ort(self, reported):
        session = Mock()
        session.get_providers.side_effect = lambda: list(reported.pop(0))
        return SimpleNamespace(InferenceSession=Mock(return_value=session)), session

    def session(self, policy, use_cuda, reported):
        from native.python.voice_runtime import onnx_engine
        ort, _ = self.ort(reported)
        with patch.dict(os.environ, {'VOICE_ACCELERATOR': policy}), patch.object(accelerator, 'use_cuda', return_value=use_cuda):
            result = onnx_engine._session(ort, Path('model.onnx'))
        return result[1], [c.kwargs['providers'] for c in ort.InferenceSession.call_args_list]

    def test_cuda_accepted_when_present(self):
        provider, calls = self.session('auto', True, [['CUDAExecutionProvider', 'CPUExecutionProvider']])
        self.assertEqual(provider, 'CUDAExecutionProvider')
        self.assertEqual(calls, [['CUDAExecutionProvider', 'CPUExecutionProvider']])

    def test_cuda_silently_dropped_falls_back_to_cpu_session(self):
        # ORT drops CUDA (e.g. missing DLL) and reports CPU only: rebuild an honest CPU session.
        provider, calls = self.session('auto', True, [['CPUExecutionProvider'], ['CPUExecutionProvider']])
        self.assertEqual(provider, 'CPUExecutionProvider')
        self.assertEqual(calls, [['CUDAExecutionProvider', 'CPUExecutionProvider'], ['CPUExecutionProvider']])

    def test_no_cuda_uses_cpu(self):
        provider, calls = self.session('auto', False, [['CPUExecutionProvider']])
        self.assertEqual((provider, calls), ('CPUExecutionProvider', [['CPUExecutionProvider']]))

    def test_required_cuda_but_dropped_is_unavailable(self):
        with self.assertRaisesRegex(BackendUnavailableError, 'CUDA_REQUIRED:CUDA_SESSION_FAILED'):
            self.session('cuda', True, [['CPUExecutionProvider']])

    def test_cpu_session_must_report_exactly_cpu(self):
        for reported in ([], ['CUDAExecutionProvider'], ['CPUExecutionProvider', 'CUDAExecutionProvider']):
            with self.subTest(reported=reported), self.assertRaises(BackendUnavailableError):
                self.session('auto', False, [reported])


class RegistryEvidenceTest(unittest.TestCase):
    def provider(self, evidence):
        from native.python.voice_runtime.backend_registry import BackendRegistry
        registry = BackendRegistry(platform_name='win32', arch_name='x64', stt_choice='faster-whisper',
                                   tts_choice='kokoro-onnx', availability={'faster-whisper': True, 'kokoro-onnx': True})
        owner = object()
        registry._tts = owner
        registry._tts_provider_reader = (owner, lambda _: evidence)
        return registry._execution_provider()

    def test_cuda_evidence(self):
        good = dict(requested='CUDAExecutionProvider', sessionProviders=['CUDAExecutionProvider', 'CPUExecutionProvider'],
                    modelLoaded=True, inferenceSucceeded=True, executionProvider='CUDAExecutionProvider')
        self.assertEqual(self.provider(good), 'CUDAExecutionProvider')
        for field, bad in [('requested', 'CPUExecutionProvider'), ('sessionProviders', ['CPUExecutionProvider']),
                           ('sessionProviders', ['CUDAExecutionProvider']), ('inferenceSucceeded', False),
                           ('executionProvider', 'TensorrtExecutionProvider')]:
            with self.subTest(field=field, bad=bad):
                self.assertIsNone(self.provider({**good, field: bad}))


if __name__ == '__main__':
    unittest.main()
