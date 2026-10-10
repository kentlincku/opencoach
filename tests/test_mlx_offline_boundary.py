"""Portable MLX admission/PCM tests, not model validity or native inference.

Only the upstream transcriber is doubled. Tiny local assets admit that double;
they are deliberately NOT usable MLX models.
"""
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import Mock, patch

from native.python.voice_runtime.backends.base import BackendUnavailableError
from native.python.voice_runtime.backends.mlx_whisper import MLXWhisperBackend


class MLXOfflineBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.audio = self.root / 'input.wav'
        with wave.open(str(self.audio), 'wb') as wav:
            wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            wav.writeframes(b'\x00\x80\x00\x00\x00\x40')
        self.model = self.root / 'model'
        self.model.mkdir()
        (self.model / 'config.json').write_text('{"n_mels":80}')
        (self.model / 'model.safetensors').write_bytes(b'admission-only, not weights')
        self.transcriber = Mock(return_value={'text': ' hello '})

    def backend(self, model=None):
        return MLXWhisperBackend(model_id=str(self.model) if model is None else model,
                                 allowed_audio_root=self.root, transcriber=self.transcriber)

    def test_rejects_missing_local_configuration_before_obtaining_upstream(self):
        (self.model / 'config.json').unlink()
        backend = self.backend()
        with patch.object(backend, '_get_transcriber', return_value=self.transcriber) as obtain:
            with self.assertRaises(BackendUnavailableError):
                backend.transcribe(str(self.audio))
            obtain.assert_not_called()
        self.transcriber.assert_not_called()

    def test_bounded_asset_admission_rejects_unusable_layout_before_upstream(self):
        # Fixed filenames only; never read weights or walk an asset tree.
        import os
        for filename, shape in [
            ('model.safetensors', 'missing'), ('model.safetensors', 'empty'),
            ('model.safetensors', 'directory'), ('model.safetensors', 'fifo'),
            ('model.safetensors', 'escape'), ('config.json', 'empty'),
            ('config.json', 'directory'), ('config.json', 'fifo'),
            ('config.json', 'escape'), ('config.json', 'dangling'),
        ]:
            with self.subTest(filename=filename, shape=shape), tempfile.TemporaryDirectory() as temp:
                model = Path(temp) / 'model'
                model.mkdir()
                (model / 'config.json').write_text('{"n_mels":80}')
                (model / 'model.safetensors').write_bytes(b'admission-only')
                asset = model / filename
                asset.unlink()
                if shape == 'empty': asset.touch()
                elif shape == 'directory': asset.mkdir()
                elif shape == 'fifo': os.mkfifo(asset)
                elif shape == 'escape': asset.symlink_to(self.model / filename)
                elif shape == 'dangling': asset.symlink_to(model / 'missing-private')
                backend = self.backend(str(model))
                with patch.object(backend, '_get_transcriber', return_value=self.transcriber) as obtain:
                    with self.assertRaisesRegex(BackendUnavailableError, 'LOCAL_MODEL_REQUIRED') as caught:
                        backend.transcribe(str(self.audio))
                    self.assertNotIn(temp, str(caught.exception))
                    obtain.assert_not_called()
        self.transcriber.assert_not_called()

    def test_owned_pcm_reaches_upstream_without_path_decoder_or_network(self):
        import numpy as np
        import builtins
        original_import = builtins.__import__
        def guarded_import(name, *args, **kwargs):
            if name.split('.')[0] in {'mlx', 'mlx_whisper', 'huggingface_hub', 'av'}:
                self.fail('unexpected native/download import: ' + name)
            return original_import(name, *args, **kwargs)
        with patch('builtins.__import__', side_effect=guarded_import), \
                patch('subprocess.Popen', side_effect=AssertionError('no PATH ffmpeg')) as spawn, \
                patch('socket.socket.connect', side_effect=AssertionError('no network')) as network:
            backend = self.backend()
            result = backend.transcribe(str(self.audio), 'en')
            samples = self.transcriber.call_args.args[0]
            self.assertIsInstance(samples, np.ndarray)
            self.assertEqual(samples.dtype, np.float32)
            self.assertEqual(samples.shape, (3,))
            self.assertTrue(samples.flags.owndata)
            np.testing.assert_array_equal(samples, [-1, 0, 0.5])
            self.assertEqual(self.transcriber.call_args.kwargs, {
                'path_or_hf_repo': str(self.model.resolve()), 'language': 'en',
                'condition_on_previous_text': False, 'temperature': 0.0})
            self.assertEqual(result, {'text': 'hello', 'language': 'en',
                                     'model': str(self.model), 'engine': 'mlx-whisper'})
            samples[:] = 1
            backend.transcribe(str(self.audio))
            np.testing.assert_array_equal(self.transcriber.call_args.args[0], [-1, 0, 0.5])
            spawn.assert_not_called()
            network.assert_not_called()

    def test_layout_precedence_revalidation_and_oserror_sanitization(self):
        # Regression controls for the bounded admission policy, not native models.
        backend = self.backend()
        for name in ['model.safetensors', 'weights.safetensors', 'weights.npz']:
            with self.subTest(name=name):
                for asset in ['model.safetensors', 'weights.safetensors', 'weights.npz']:
                    (self.model / asset).unlink(missing_ok=True)
                (self.model / name).write_bytes(b'admission-only')
                with patch.object(Path, 'iterdir', side_effect=AssertionError('no tree walk')), \
                        patch.object(Path, 'read_bytes', side_effect=AssertionError('no weight read')):
                    self.assertEqual(backend.transcribe(str(self.audio))['text'], 'hello')
                self.transcriber.reset_mock()
                (self.model / name).unlink()
                with patch.object(backend, '_get_transcriber', return_value=self.transcriber) as obtain:
                    with self.assertRaisesRegex(BackendUnavailableError, 'LOCAL_MODEL_REQUIRED'):
                        backend.transcribe(str(self.audio))
                    obtain.assert_not_called()
        (self.model / 'weights.npz').write_bytes(b'admission-only')
        for shape in ['empty', 'dangling', 'loop']:
            preferred = self.model / 'model.safetensors'
            if shape == 'empty': preferred.touch()
            elif shape == 'dangling': preferred.symlink_to(self.model / 'missing')
            else: preferred.symlink_to(preferred)
            with self.subTest(preferred=shape), self.assertRaisesRegex(BackendUnavailableError, 'LOCAL_MODEL_REQUIRED'):
                backend.transcribe(str(self.audio))
            preferred.unlink()
        for error in [PermissionError('/private/model'), OSError('/private/model')]:
            with patch.object(Path, 'lstat', side_effect=error), \
                    patch.object(backend, '_get_transcriber', return_value=self.transcriber) as obtain:
                with self.assertRaises(BackendUnavailableError) as caught:
                    backend.transcribe(str(self.audio))
                self.assertNotIn('/private', str(caught.exception))
                self.assertIsNone(caught.exception.__cause__)
                obtain.assert_not_called()
        self.transcriber.assert_not_called()

    def test_bad_audio_and_language_never_obtain_upstream(self):
        backend = self.backend()
        with patch.object(backend, '_get_transcriber', return_value=self.transcriber) as obtain:
            for rate, channels, frames, code in [(8000, 1, b'\0\0', 'UNSUPPORTED_WAV_FORMAT'),
                                                  (16000, 1, b'', 'INVALID_WAV')]:
                with wave.open(str(self.audio), 'wb') as wav:
                    wav.setparams((channels, 2, rate, 0, 'NONE', 'not compressed'))
                    wav.writeframes(frames)
                with self.assertRaisesRegex(ValueError, code):
                    backend.transcribe(str(self.audio))
            self.audio.write_bytes(b'not WAV')
            with self.assertRaisesRegex(ValueError, 'INVALID_WAV'):
                backend.transcribe(str(self.audio))
            (self.model / 'config.json').unlink()
            with self.assertRaisesRegex(ValueError, 'INVALID_LANGUAGE'):
                backend.transcribe(str(self.audio), '../../private')
            with self.assertRaisesRegex(ValueError, 'AUDIO_PATH_OUTSIDE_RUNTIME_TEMP'):
                backend.transcribe('/etc/passwd')
            obtain.assert_not_called()
        self.transcriber.assert_not_called()

    def test_requires_explicit_existing_local_directory_before_obtaining_upstream(self):
        for model in ['mlx-community/whisper-large-v3-turbo', 'base.en',
                      str(self.root / 'missing'), str(self.audio), './model']:
            with self.subTest(model=model):
                backend = self.backend(model)
                with patch.object(backend, '_get_transcriber', return_value=self.transcriber) as obtain:
                    with self.assertRaisesRegex(BackendUnavailableError, 'LOCAL_MODEL_REQUIRED'):
                        backend.transcribe(str(self.audio))
                    obtain.assert_not_called()
        self.transcriber.assert_not_called()
