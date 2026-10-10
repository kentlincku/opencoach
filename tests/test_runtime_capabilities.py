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


class RuntimeCapabilitiesTest(unittest.TestCase):
    def test_desktop_does_not_coerce_tts_objects_to_strings(self):
        self.assertNotIn("String(payload?.text", DESKTOP_MAIN)
        self.assertIn("typeof payload?.text !== 'string'", DESKTOP_MAIN)

    def test_desktop_forwards_backend_configuration_allowlist(self):
        for name in (
            "VOICE_RUNTIME_DEBUG",
            "VOICE_STT_BACKEND",
            "VOICE_TTS_BACKEND",
            "VOICE_MLX_WHISPER_MODEL",
            "VOICE_FASTER_WHISPER_MODEL",
            "VOICE_FASTER_WHISPER_DEVICE",
            "VOICE_FASTER_WHISPER_COMPUTE_TYPE",
            "VOICE_KOKORO_ONNX_MODEL",
            "VOICE_KOKORO_ONNX_VOICES",
        ):
            self.assertIn(f"'{name}'", DESKTOP_MAIN)
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


class PassiveProviderHealthTest(unittest.TestCase):
    """Real server/registry/default backend/K/M/G; only ORT, NLP and data doubled."""
    def setUp(self):
        from unittest.mock import patch
        from tests.test_onnx_engine import SyntheticResources
        from native.python.voice_runtime.backend_registry import BackendRegistry
        temp = tempfile.TemporaryDirectory(prefix='health-v4-')
        self.addCleanup(temp.cleanup)
        self.f = SyntheticResources(Path(temp.name))
        self.addCleanup(self.f.close)
        self.enterContext(self.f.boundaries())
        self.enterContext(patch.dict(os.environ, {
            'VOICE_KOKORO_ONNX_MODEL': str(self.f.model),
            'VOICE_KOKORO_ONNX_VOICES': str(self.f.voices),
            'VOICE_STT_BACKEND': 'faster-whisper', 'VOICE_TTS_BACKEND': 'kokoro-onnx',
        }))
        self.registry = BackendRegistry(platform_name='win32', arch_name='x64')
        self.enterContext(patch.object(server, 'backend_registry', self.registry))
        self.trace = {}

    def health(self, label):
        result = server.dispatch('runtime.health', {})
        self.assertEqual(result, server.health_capabilities(registry=self.registry))
        self.assertTrue(set(result).issubset(SCHEMA['properties']))
        self.trace[label] = result
        return result

    def speak(self, text='hello world'):
        return server.dispatch('tts.synthesize', {'text': text, 'voice': 'af_heart', 'speed': 1})

    def test_actual_server_wav_then_passive_cpu_history(self):
        import base64
        import io
        import wave
        from unittest.mock import patch
        from native.python.voice_runtime.backends.base import BackendInputError
        cold = self.health('cold')
        self.assertTrue(cold['ready'])
        self.assertIsNone(cold.get('executionProvider'))
        self.assertIsNone(self.registry._tts)
        server.dispatch('runtime.probe', {})
        self.assertIsNone(self.registry._tts)
        with self.assertRaises(BackendInputError):
            self.speak('1e-7')
        self.f.session_factory.assert_not_called()
        self.assertIsNone(self.health('invalid_before_load').get('executionProvider'))
        result = self.speak()
        with wave.open(io.BytesIO(base64.b64decode(result['audio'])), 'rb') as wav:
            self.assertEqual(wav.getframerate(), 24000)
            self.assertGreater(wav.getnframes(), 0)
        self.assertEqual(self.health('success').get('executionProvider'), 'CPUExecutionProvider')
        calls = list(self.f.session.mock_calls)
        # Imports are forbidden even when modules are cached. No file/session work on observation.
        with patch('os.stat', side_effect=AssertionError('health stat')), \
             patch('builtins.open', side_effect=AssertionError('health open')), \
             patch.object(self.f.session, 'get_providers', side_effect=AssertionError('health session')), \
             patch.object(self.f.session, 'get_modelmeta', side_effect=AssertionError('health metadata')), \
             patch.object(self.f.session, 'run', side_effect=AssertionError('health run')), \
             patch('builtins.__import__', side_effect=AssertionError('health import')):
            for _ in range(3):
                self.assertEqual(self.health('repeated')['executionProvider'], 'CPUExecutionProvider')
                server.dispatch('runtime.probe', {})
        self.assertEqual(self.f.session.mock_calls, calls)
        with self.assertRaises(BackendInputError):
            self.speak('1e-7')
        self.assertEqual(self.health('input_error')['executionProvider'], 'CPUExecutionProvider')
        self.assertTrue(self.trace['input_error']['ready'])
        self.f.session.run.side_effect = RuntimeError('private run fault')
        with self.assertRaisesRegex(RuntimeError, '^BACKEND_ERROR:tts:kokoro-onnx$') as first:
            self.speak()
        failed = self.health('run_error')
        self.assertIsNone(failed['executionProvider'])
        self.assertFalse(failed['ready'])
        self.assertIsNone(failed['selectedTts'])
        self.assertFalse(self.registry._tts.provider_evidence()['inferenceSucceeded'])
        with self.assertRaises(RuntimeError) as second:
            self.speak()
        self.assertIs(first.exception, second.exception)
        self.f.session_factory.assert_called_once()

    def test_fake_apple_foreign_and_ordinary_engine_cannot_mint_cpu(self):
        from types import SimpleNamespace
        from native.python.voice_runtime.backend_registry import BackendRegistry
        from native.python.voice_runtime.backends.kokoro_onnx import KokoroOnnxBackend
        evidence = dict(requested='CPUExecutionProvider', sessionProviders=['CPUExecutionProvider'],
                        modelLoaded=True, inferenceSucceeded=True, executionProvider='CPUExecutionProvider')
        reads = []
        foreign = SimpleNamespace(
            synthesize=lambda *args: {'audio': 'not-real'},
            provider_evidence=lambda: reads.append('foreign') or evidence)
        ordinary = KokoroOnnxBackend(engine_factory=lambda *_: SimpleNamespace(
            create=lambda *args, **kwargs: ([0.1, 0.2], 24000)))
        for backend in (foreign, ordinary):
            registry = BackendRegistry(platform_name='win32', arch_name='x64',
                availability={'faster-whisper': True, 'kokoro-onnx': True},
                factories={'kokoro-onnx': lambda: backend})
            registry.synthesize('hello', 'af_heart', 1.0)
            self.assertIsNone(server.health_capabilities(registry=registry)['executionProvider'])
            self.assertTrue(registry.capabilities()['ready'])
        self.assertEqual(reads, [])
        fake = BackendRegistry(platform_name='win32', arch_name='x64', fake=True)
        fake.synthesize('hello', 'af_heart', 1.0)
        self.assertIsNone(fake.capabilities()['executionProvider'])
        apple = BackendRegistry(platform_name='darwin', arch_name='arm64',
            stt_choice='auto', tts_choice='auto', availability={
                'mlx-whisper': True, 'faster-whisper': True, 'kokoro-python': True, 'kokoro-onnx': True},
            factories={'kokoro-python': lambda: foreign})
        apple.synthesize('hello', 'af_heart', 1.0)
        self.assertEqual(apple.capabilities()['selectedStt'], 'mlx-whisper')
        self.assertEqual(apple.capabilities()['selectedTts'], 'kokoro-python')
        self.assertIsNone(apple.capabilities()['executionProvider'])
        self.assertEqual(reads, [])

    def test_complete_consistency_detachment_and_original_owner_binding(self):
        from unittest.mock import patch
        self.speak()
        owner = self.registry._tts
        good = owner.provider_evidence()
        detached = owner.provider_evidence()
        detached['sessionProviders'].append('DmlExecutionProvider')
        self.assertEqual(owner.provider_evidence(), good)
        response = self.health('success')
        response['executionProvider'] = 'DmlExecutionProvider'
        response['ttsBackends'].clear()
        self.assertEqual(self.health('detached')['executionProvider'], 'CPUExecutionProvider')
        # White-box corrupted-cache controls: never used as positive execution evidence.
        for field, bad in [('requested', 'DmlExecutionProvider'), ('sessionProviders', []),
                           ('sessionProviders', ['CPUExecutionProvider', 'DmlExecutionProvider']),
                           ('modelLoaded', 1), ('inferenceSucceeded', 'yes'),
                           ('executionProvider', 'DmlExecutionProvider')]:
            for data in ({**good, field: bad}, {k: v for k, v in good.items() if k != field}):
                with self.subTest(field=field, data=data), patch.object(
                        self.registry, '_tts_provider_reader', (owner, lambda _: data)):
                    self.assertIsNone(self.health('inconsistent')['executionProvider'])
        with patch.object(owner, 'provider_evidence', side_effect=AssertionError('instance override')):
            self.assertEqual(self.health('known_reader')['executionProvider'], 'CPUExecutionProvider')
        with patch.object(self.registry, '_tts', object()):
            self.assertIsNone(self.health('foreign_owner')['executionProvider'])
        with patch.object(self.registry, 'selected_tts', 'kokoro-python'):
            self.assertIsNone(self.health('not_selected')['executionProvider'])
        with patch.object(self.registry, '_tts_failure', RuntimeError('sticky')):
            self.assertIsNone(self.health('sticky')['executionProvider'])

    def test_new_registry_has_no_old_success_or_failure_history(self):
        from native.python.voice_runtime.backend_registry import BackendRegistry
        self.speak()
        old = self.registry
        fresh = BackendRegistry(platform_name='win32', arch_name='x64')
        self.assertIsNone(fresh.capabilities()['executionProvider'])
        self.assertIsNone(fresh._tts)
        self.assertIsNone(fresh._get_tts().provider_evidence()['executionProvider'])
        self.assertIsNot(fresh._tts, old._tts)
        self.f.session.run.side_effect = RuntimeError('old failure')
        with self.assertRaises(RuntimeError):
            self.speak()
        self.assertIsNone(old.capabilities()['executionProvider'])
        import numpy as np
        self.f.session.run.side_effect = lambda *_: [np.full(4096, 0.1, dtype=np.float32)]
        fresh.synthesize('hello', 'af_heart', 1.0)
        self.assertEqual(fresh.capabilities()['executionProvider'], 'CPUExecutionProvider')
        self.assertIsNone(old.capabilities()['executionProvider'])
        self.assertIsNone(old.selected_tts)
        self.assertTrue(fresh.capabilities()['ready'])

    def test_load_resource_empty_nonfinite_rate_and_wav_failures_clear_history(self):
        from contextlib import ExitStack
        from typing import Any, cast
        from unittest.mock import patch
        from native.python.voice_runtime.backend_registry import BackendRegistry
        import numpy as np
        for phase in ('load', 'resource', 'empty', 'nonfinite', 'rate', 'wav'):
            with self.subTest(phase=phase), ExitStack() as stack:
                registry = BackendRegistry(platform_name='win32', arch_name='x64')
                stack.enter_context(patch.object(server, 'backend_registry', registry))
                self.f.session.run.side_effect = lambda *_: [np.full(4096, 0.1, dtype=np.float32)]
                if phase == 'load':
                    stack.enter_context(patch.object(self.f, 'session_factory', self.f.session_factory))
                    self.f.session_factory.side_effect = RuntimeError('load fault')
                else:
                    self.speak()
                    self.assertEqual(server.dispatch('runtime.health', {})['executionProvider'], 'CPUExecutionProvider')
                    engine = cast(Any, registry._tts)._engine
                    if phase == 'resource':
                        # Explicit active-resource fault. A warm resident session
                        # does not reload model bytes or re-run cold profile admission.
                        stack.enter_context(patch.object(engine._g, 'vocab', {}))
                    elif phase == 'empty':
                        self.f.session.run.side_effect = lambda *_: [np.array([], dtype=np.float32)]
                    elif phase == 'nonfinite':
                        self.f.session.run.side_effect = lambda *_: [np.array([float('nan')], dtype=np.float32)]
                    elif phase == 'rate':
                        # Bind the actual owned engine, not a stale parent-package
                        # module alias after another fixture restores sys.modules.
                        stack.enter_context(patch.object(engine, 'create', return_value=([0.1], 16000)))
                    else:
                        stack.enter_context(patch('native.python.voice_runtime.backends.kokoro_onnx.samples_to_wav',
                                                  side_effect=OSError('WAV failed')))
                with self.assertRaises(RuntimeError) as first:
                    self.speak()
                failed = server.dispatch('runtime.health', {})
                self.assertIsNone(failed['executionProvider'])
                self.assertFalse(failed['ready'])
                self.assertNotIn('kokoro-onnx', failed['ttsBackends'])
                self.assertFalse(registry._tts.provider_evidence()['inferenceSucceeded'])
                with self.assertRaises(RuntimeError) as second:
                    self.speak()
                self.assertIs(first.exception, second.exception)
                self.f.session_factory.side_effect = None


if __name__ == "__main__":
    unittest.main()