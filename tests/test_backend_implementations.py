import tempfile
import unittest
import base64
import wave
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from native.python.voice_runtime.backends.faster_whisper import FasterWhisperBackend
from native.python.voice_runtime.backends.mlx_whisper import MLXWhisperBackend
from native.python.voice_runtime.backends.kokoro_python import KokoroPythonBackend
from native.python.voice_runtime.backends.kokoro_onnx import KokoroOnnxBackend


class MLXWhisperBackendTest(unittest.TestCase):
    def test_legacy_whisper_model_environment_variable_remains_supported(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            "os.environ",
            {"VOICE_WHISPER_MODEL": "legacy-model"},
            clear=True,
        ):
            backend = MLXWhisperBackend(
                allowed_audio_root=Path(temp_dir),
                transcriber=lambda *_args, **_kwargs: {"text": "ok"},
            )

        self.assertEqual(backend.model_id, "legacy-model")

    def test_transcribe_validates_path_and_uses_injected_transcriber(self):
        calls = []

        def transcriber(path, **kwargs):
            calls.append((path, kwargs))
            return {"text": "  Hello world  "}

        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "sample.wav"
            with wave.open(str(audio), "wb") as wav_file:
                wav_file.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav_file.writeframes(b"\x00\x00\x00\x40")
            # Local admission fixture only, not a usable MLX model.
            model = Path(temp_dir) / "model"
            model.mkdir()
            (model / "config.json").write_text('{"n_mels":80}')
            (model / "model.safetensors").write_bytes(b"admission-only")
            backend = MLXWhisperBackend(
                model_id=str(model),
                allowed_audio_root=Path(temp_dir),
                transcriber=transcriber,
            )

            result = backend.transcribe(str(audio), "en")

            self.assertEqual(result, {
                "text": "Hello world",
                "language": "en",
                "model": str(model),
                "engine": "mlx-whisper",
            })
            import numpy as np
            self.assertIsInstance(calls[0][0], np.ndarray)
            self.assertEqual(calls[0][0].dtype, np.float32)
            self.assertEqual(calls[0][0].shape, (2,))
            self.assertTrue(calls[0][0].flags.owndata)
            np.testing.assert_array_equal(calls[0][0], [0, 0.5])
            self.assertEqual(calls[0][1]["path_or_hf_repo"], str(model))

            with self.assertRaisesRegex(ValueError, "AUDIO_PATH_OUTSIDE_RUNTIME_TEMP"):
                backend.transcribe("/etc/passwd", "en")
            with self.assertRaisesRegex(ValueError, "INVALID_LANGUAGE"):
                backend.transcribe(str(audio), "../../secret")


class FasterWhisperBackendTest(unittest.TestCase):
    def test_lazy_default_factory_imports_actual_private_vendor_in_fresh_process(self):
        """Generated vendor imports unchanged; only external/model boundaries doubled."""
        import subprocess
        import sys

        code = r'''
import hashlib, importlib, importlib.abc, json, os, sys, tempfile, types, wave, zipfile
from pathlib import Path
from unittest.mock import Mock, patch
import numpy as np
from native.python.voice_runtime.backends.faster_whisper import FasterWhisperBackend
prefix = 'voice_practice_speech_vendor'
assert not any(n == prefix or n.startswith(prefix+'.') for n in sys.modules)
blocked = Mock(side_effect=AssertionError('NATIVE_OR_DOWNLOAD_NOT_ALLOWED'))
class Fence(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'av', 'faster_whisper', 'onnxruntime'}:
            raise ImportError('FORBIDDEN_IMPORT:'+fullname)
sys.meta_path.insert(0, Fence())
def module(name, **attrs):
    value = types.ModuleType(name); value.__dict__.update(attrs); return value
external = {
    'ctranslate2': module('ctranslate2', StorageView=object,
        models=types.SimpleNamespace(Whisper=blocked, WhisperGenerationResult=object)),
    'tokenizers': module('tokenizers', Tokenizer=types.SimpleNamespace(
        from_file=blocked, from_pretrained=blocked, from_buffer=blocked)),
    'huggingface_hub': module('huggingface_hub', snapshot_download=blocked, hf_hub_download=blocked),
    'tqdm': module('tqdm', tqdm=blocked), 'tqdm.auto': module('tqdm.auto', tqdm=blocked),
}
sys.modules.update(external)
with patch('socket.socket.connect', blocked), patch('socket.create_connection', blocked):
    vendor = importlib.import_module(prefix+'.faster_whisper')
    build = Path(os.environ['SPEECH_VENDOR_BUILD'])
    receipt = json.loads((build/'build-result.json').read_text())
    wheel = build/receipt['wheel']
    assert hashlib.sha256(wheel.read_bytes()).hexdigest() == receipt['sha256']
    origins = {}
    with zipfile.ZipFile(wheel) as archive:
        for name, loaded in list(sys.modules.items()):
            if name == prefix or name.startswith(prefix+'.'):
                origin = Path(loaded.__file__).resolve()
                member = origin.relative_to((build/'source').resolve()).as_posix()
                assert origin.read_bytes() == archive.read(member)
                origins[name] = str(origin)
    assert prefix+'.faster_whisper.transcribe' in origins
    assert vendor.WhisperModel.__module__ == prefix+'.faster_whisper.transcribe'
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp); model_dir = root/'local'; model_dir.mkdir()
        (model_dir/'tokenizer.json').write_text('{}')
        audio = root/'input.wav'
        with wave.open(str(audio), 'wb') as wav_file:
            wav_file.setparams((1,2,16000,0,'NONE','not compressed'))
            wav_file.writeframes(b'\x00\x00\x00\x40')
        events = []
        # Exercise the real loaded-language property, including codes beyond the
        # runtime's accepted request subset; CT2 state is explicitly doubled.
        language_model = object.__new__(vendor.WhisperModel)
        language_model.model = types.SimpleNamespace(is_multilingual=True)
        class ModelBoundary:
            @property
            def supported_languages(self):
                return language_model.supported_languages

            def transcribe(self, samples, **kwargs):
                assert isinstance(samples, np.ndarray) and samples.dtype == np.float32
                np.testing.assert_array_equal(samples, [0,0.5])
                assert kwargs == dict(language='en', vad_filter=True, condition_on_previous_text=False)
                def segments():
                    yield types.SimpleNamespace(text=' vendor-boundary ')
                    events.append('completed')
                return segments(), None
        factory = Mock(return_value=ModelBoundary())
        with patch.dict(os.environ, {'HF_HUB_OFFLINE':'1', 'TRANSFORMERS_OFFLINE':'0',
                'VOICE_RUNTIME_TEMP_DIR':temp, 'VOICE_FASTER_WHISPER_MODEL':str(model_dir),
                'VOICE_FASTER_WHISPER_DEVICE':'cpu', 'VOICE_FASTER_WHISPER_COMPUTE_TYPE':'int8'}), \
                patch.object(vendor, 'WhisperModel', factory):
            from native.python.voice_runtime import server
            from native.python.voice_runtime.backend_registry import BackendRegistry
            # Actual default backend factory, injected availability only (V4 deferred).
            registry = BackendRegistry(platform_name='windows', arch_name='x64',
                stt_choice='faster-whisper', tts_choice='kokoro-onnx',
                availability={'faster-whisper':True, 'kokoro-onnx':True})
            assert registry.capabilities()['ready']; factory.assert_not_called()
            with patch.object(server, 'backend_registry', registry):
                for _ in range(2):
                    result = server.dispatch('stt.transcribe', {'audioPath':str(audio)})
                    assert result['text'] == 'vendor-boundary'
            factory.assert_called_once_with(str(model_dir), device='cpu', compute_type='int8', local_files_only=True)
            assert events == ['completed', 'completed']
    blocked.assert_not_called()
print('REAL_VENDOR_DEFAULT_DISPATCH '+json.dumps(dict(wheel_sha256=receipt['sha256'],
    origins=origins, external_doubles=sorted(external), model_boundary='WhisperModel double; no native inference',
    python=sys.version.split()[0], numpy=np.__version__)))
'''
        proc = subprocess.run([sys.executable, "-B", "-c", code], capture_output=True, text=True, timeout=60)
        print(proc.stdout, end="")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("REAL_VENDOR_DEFAULT_DISPATCH ", proc.stdout)

    def test_english_only_model_rejects_other_languages(self):
        calls = []
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "sample.wav"
            with wave.open(str(audio), "wb") as wav_file:
                wav_file.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav_file.writeframes(b"\x00\x00\x00\x40")
            backend = FasterWhisperBackend(
                model_id="base.en",
                allowed_audio_root=Path(temp_dir),
                model_factory=lambda *_args, **_kwargs: SimpleNamespace(
                    supported_languages=["en"], transcribe=lambda *args, **kwargs: calls.append(args)),
            )

            with self.assertRaisesRegex(ValueError, "UNSUPPORTED_LANGUAGE_FOR_MODEL"):
                backend.transcribe(str(audio), "zh-TW")
            self.assertEqual(calls, [])

    def test_model_is_lazy_loaded_reused_and_segments_are_joined(self):
        import numpy as np

        loads = []
        calls = []

        class Model:
            supported_languages = ["en"]

            def transcribe(self, audio, **kwargs):
                calls.append((audio, kwargs))
                return [SimpleNamespace(text=" Hello "), SimpleNamespace(text="world ")], None

        def model_factory(model_id, **kwargs):
            loads.append((model_id, kwargs))
            return Model()

        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "sample.wav"
            with wave.open(str(audio), "wb") as wav_file:
                wav_file.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav_file.writeframes(b"\x00\x80\xff\x7f\x00\x00\x00\x40\xff\xff")
            from native.python.voice_runtime import accelerator
            no_cuda = patch.object(accelerator, "use_cuda", return_value=False)
            no_cuda.start()
            self.addCleanup(no_cuda.stop)
            backend = FasterWhisperBackend(
                model_id="base.en",
                allowed_audio_root=Path(temp_dir),
                model_factory=model_factory,
            )
            self.assertEqual(loads, [])

            first = backend.transcribe(str(audio), "en")
            second = backend.transcribe(str(audio), "en")

            self.assertEqual(first["text"], "Hello world")
            self.assertEqual(first["engine"], "faster-whisper")
            self.assertEqual(second["model"], "base.en")
            self.assertEqual(len(loads), 1)
            # Placement policy is covered by tests/test_accelerator.py; with CUDA
            # unavailable Windows pins explicit CPU, other platforms keep "auto".
            import sys
            self.assertEqual(loads[0], ("base.en", {
                "device": "cpu" if sys.platform == "win32" else "auto", "compute_type": "int8"}))
            for samples, kwargs in calls:
                self.assertIsInstance(samples, np.ndarray)
                self.assertEqual(samples.dtype, np.float32)
                self.assertEqual(samples.shape, (5,))
                np.testing.assert_array_equal(samples, np.array(
                    [-1.0, 32767 / 32768, 0.0, 0.5, -1 / 32768], dtype=np.float32))
                self.assertEqual(kwargs, {
                    "language": "en", "condition_on_previous_text": False, "vad_filter": True,
                })
            self.assertEqual(first["language"], "en")
            with self.assertRaisesRegex(ValueError, "AUDIO_PATH_OUTSIDE_RUNTIME_TEMP"):
                backend.transcribe(str(Path(temp_dir).parent / "outside.wav"), "en")
            with self.assertRaisesRegex(ValueError, "INVALID_LANGUAGE"):
                backend.transcribe(str(audio), "../../secret")
            self.assertEqual(len(loads), 1)


class KokoroPythonBackendTest(unittest.TestCase):
    def test_pipeline_is_lazy_reused_and_returns_wav(self):
        loads = []

        class Pipeline:
            def __call__(self, text, voice, speed):
                yield None, None, [0.0, 0.25, -0.25]

        def pipeline_factory():
            loads.append("loaded")
            return Pipeline()

        backend = KokoroPythonBackend(pipeline_factory=pipeline_factory)
        self.assertEqual(loads, [])

        first = backend.synthesize("Hello ✨", "af_heart", 1.0)
        second = backend.synthesize("Again", "af_heart", 1.0)

        self.assertEqual(loads, ["loaded"])
        self.assertEqual(first["engine"], "kokoro-python")
        self.assertEqual(second["format"], "audio/wav")
        with wave.open(BytesIO(base64.b64decode(first["audio"])), "rb") as wav_file:
            self.assertEqual(wav_file.getframerate(), 24000)
            self.assertEqual(wav_file.getnchannels(), 1)
        with self.assertRaisesRegex(ValueError, "INVALID_TEXT_LENGTH"):
            backend.synthesize("x" * 5001, "af_heart", 1.0)


class KokoroOnnxBackendTest(unittest.TestCase):
    def test_default_actual_producer_lazy_reuse_wav_and_passive_evidence(self):
        import builtins
        from unittest.mock import Mock
        from tests.test_onnx_engine import SyntheticResources
        from native.python.voice_runtime.backends.base import BackendInputError
        from contextlib import closing
        with tempfile.TemporaryDirectory() as tmp, closing(SyntheticResources(Path(tmp))) as f:
            backend=KokoroOnnxBackend(model_path=f.model,voices_path=f.voices)
            self.assertTrue(callable(getattr(backend,'provider_evidence',None)), 'cached evidence producer missing')
            empty=dict(requested=None,sessionProviders=[],modelLoaded=False,inferenceSucceeded=False,executionProvider=None)
            self.assertEqual(backend.provider_evidence(),empty)
            with f.boundaries():
                for text in ['1e-7','−0.5','[word](/fake/)']:
                    with self.assertRaises(BackendInputError):
                        backend.synthesize(text,'af_heart',1.0)
                f.session_factory.assert_not_called()
                for text in ['hello world','-0.00','RTX4070']:
                    result=backend.synthesize(text,'af_heart',1.0)
                    with wave.open(BytesIO(base64.b64decode(result['audio']))) as wav:
                        self.assertEqual(wav.getframerate(),24000)
                        self.assertGreater(wav.getnframes(),0)
                f.session_factory.assert_called_once()
                self.assertEqual(f.session.run.call_count,3)
                expected=dict(requested='CPUExecutionProvider',sessionProviders=['CPUExecutionProvider'],modelLoaded=True,inferenceSucceeded=True,executionProvider='CPUExecutionProvider')
                self.assertEqual(backend.provider_evidence(),expected)
                deny=Mock(side_effect=AssertionError('PASSIVE_READ_WORK'))
                with patch.object(builtins,'__import__',deny),patch.object(builtins,'open',deny),patch.object(f.session,'get_providers',deny):
                    copy=backend.provider_evidence(); copy['sessionProviders'].clear()
                    self.assertEqual(backend.provider_evidence(),expected)
                deny.assert_not_called()
                for text in ['1e-7', "hello qzx'foo"]:
                    with self.assertRaises(BackendInputError):
                        backend.synthesize(text,'af_heart',1.0)
                    self.assertEqual(backend.provider_evidence(),expected)
                self.assertEqual(f.session.run.call_count,3)
            fresh=KokoroOnnxBackend(model_path=f.model,voices_path=f.voices)
            self.assertEqual(fresh.provider_evidence(),empty)

    def test_waveform_validation_and_no_cpu_from_ordinary_factory(self):
        import numpy as np
        from native.python.voice_runtime.backends.base import BackendExecutionError
        with tempfile.TemporaryDirectory() as tmp:
            model,voices=Path(tmp)/'model',Path(tmp)/'voices'
            model.write_bytes(b'synthetic'); voices.write_bytes(b'synthetic')
            engine=SimpleNamespace(create=lambda *a,**k:([0.0],24000),
                provider_evidence=lambda:dict(requested='CPUExecutionProvider',sessionProviders=['CPUExecutionProvider'],modelLoaded=True,inferenceSucceeded=True,executionProvider='CPUExecutionProvider'))
            backend=KokoroOnnxBackend(model_path=model,voices_path=voices,engine_factory=lambda *a:engine)
            backend.synthesize('hello','af_heart',1.0)
            self.assertIsNone(backend.provider_evidence()['executionProvider'])
            for samples,rate in [([],24000),([float('nan')],24000),([float('inf')],24000),
                    ([[0.1]],24000),(np.array([[0.1]]),24000),([0.1],22050),([0.1],24000.1),([0.1],'24000'),([0.1],True),([1j],24000)]:
                with self.subTest(samples=repr(samples),rate=rate):
                    engine.create=lambda *a,**k:(samples,rate)
                    with self.assertRaises(BackendExecutionError):
                        backend.synthesize('hello','af_heart',1.0)
                    self.assertIsNone(backend.provider_evidence()['executionProvider'])

    def test_actual_producer_failures_clear_only_after_wav_success(self):
        import numpy as np
        from tests.test_onnx_engine import SyntheticResources
        from native.python.voice_runtime.backends.base import BackendExecutionError,BackendUnavailableError
        from contextlib import closing
        with tempfile.TemporaryDirectory() as tmp, closing(SyntheticResources(Path(tmp))) as f:
            backend=KokoroOnnxBackend(model_path=f.model,voices_path=f.voices)
            empty=backend.provider_evidence()
            with f.boundaries():
                original=f.session.run.side_effect
                for fault in ['voice','run','empty','nonfinite','wav','identity']:
                    f.session.run.side_effect=original
                    backend.synthesize('hello','af_heart',1.0)
                    self.assertTrue(backend.provider_evidence()['inferenceSucceeded'])
                    if fault=='run': f.session.run.side_effect=RuntimeError('secret dependency text')
                    if fault=='empty': f.session.run.side_effect=lambda *_:[np.array([],dtype=np.float32)]
                    if fault=='nonfinite': f.session.run.side_effect=lambda *_:[np.full(4096,np.nan,dtype=np.float32)]
                    if fault=='identity': backend._engine._kokoro.sess=SimpleNamespace(run=lambda *_:[np.ones(4096)])
                    if fault=='wav':
                        def fail_wav(*args):
                            self.assertTrue(backend.provider_evidence()['inferenceSucceeded'])
                            raise RuntimeError('private path')
                        with patch('native.python.voice_runtime.backends.kokoro_onnx.samples_to_wav',side_effect=fail_wav),self.assertRaises(BackendExecutionError):
                            backend.synthesize('hello','af_heart',1.0)
                    else:
                        with self.subTest(fault=fault),self.assertRaises((BackendExecutionError,BackendUnavailableError)):
                            backend.synthesize('hello','missing' if fault=='voice' else 'af_heart',1.0)
                    self.assertEqual(backend.provider_evidence(),empty)
                    backend._engine._kokoro.sess=f.session
                # A first WAV failure cannot create historical success.
                fresh=KokoroOnnxBackend(model_path=f.model,voices_path=f.voices)
                f.session.run.side_effect=original
                def first_wav(*args):
                    self.assertEqual(fresh.provider_evidence(),empty)
                    raise RuntimeError('first WAV failed')
                with patch('native.python.voice_runtime.backends.kokoro_onnx.samples_to_wav',side_effect=first_wav),self.assertRaises(BackendExecutionError):
                    fresh.synthesize('hello','af_heart',1.0)
                self.assertEqual(fresh.provider_evidence(),empty)
                f.profile_path.unlink()
                unavailable=KokoroOnnxBackend(model_path=f.model,voices_path=f.voices)
                f.session_factory.reset_mock()
                with self.assertRaises(BackendUnavailableError):
                    unavailable.synthesize('hello','af_heart',1.0)
                f.session_factory.assert_not_called()
                self.assertEqual(unavailable.provider_evidence(),empty)

    def test_empty_engine_audio_is_rejected(self):
        class EmptyEngine:
            def create(self, text, voice, speed, lang):
                return [], 24000

        with tempfile.TemporaryDirectory() as temp_dir:
            model = Path(temp_dir) / "model.onnx"
            voices = Path(temp_dir) / "voices.bin"
            model.write_bytes(b"model")
            voices.write_bytes(b"voices")
            backend = KokoroOnnxBackend(
                model_path=model,
                voices_path=voices,
                engine_factory=lambda *_args: EmptyEngine(),
            )

            with self.assertRaisesRegex(RuntimeError, "^BACKEND_ERROR:tts:kokoro-onnx$"):
                backend.synthesize("Hello", "af_heart", 1.0)

    def test_engine_assets_are_validated_and_engine_is_reused(self):
        loads = []

        class Engine:
            def create(self, text, voice, speed, lang):
                return [0.0, 0.1, -0.1], 24000

        def engine_factory(model_path, voices_path):
            loads.append((model_path, voices_path))
            return Engine()

        with tempfile.TemporaryDirectory() as temp_dir:
            model = Path(temp_dir) / "kokoro-v1.0.onnx"
            voices = Path(temp_dir) / "voices-v1.0.bin"
            model.write_bytes(b"model")
            voices.write_bytes(b"voices")
            backend = KokoroOnnxBackend(
                model_path=model,
                voices_path=voices,
                engine_factory=engine_factory,
            )
            self.assertEqual(loads, [])

            result = backend.synthesize("Hello", "af_heart", 1.0)
            backend.synthesize("Again", "af_heart", 1.0)

            self.assertEqual(len(loads), 1)
            self.assertEqual(result["engine"], "kokoro-onnx")
            self.assertEqual(result["sampleRate"], 24000)


if __name__ == "__main__":
    unittest.main()
