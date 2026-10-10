import unittest

from native.python.voice_runtime.text import clean_text_for_speech


class SpeechTextPolicyTest(unittest.TestCase):
    def test_native_tts_removes_cjk_characters(self):
        self.assertEqual(clean_text_for_speech("Hello 你好，how are you？"), "Hello, how are you?")
        self.assertEqual(clean_text_for_speech("這是一段中文。"), "")


    def test_existing_cleaner_both_tts_routes_unchanged(self):
        # Characterization: injected waveform/pipeline, not native audio verification.
        from pathlib import Path
        import tempfile
        from native.python.voice_runtime.backends.kokoro_onnx import KokoroOnnxBackend
        from native.python.voice_runtime.backends.kokoro_python import KokoroPythonBackend
        from native.python.voice_runtime.backends.base import BackendInputError
        seen = []
        class Engine:
            def create(self, text, **kwargs):
                seen.append(('onnx', text, kwargs))
                return [0.0], 24000
        def pipeline(text, **kwargs):
            seen.append(('python', text, kwargs))
            return [(None,None,[0.0])]
        with tempfile.TemporaryDirectory(prefix='speech-policy-') as tmp:
            model, voices = Path(tmp)/'model', Path(tmp)/'voices'
            model.write_bytes(b'synthetic'); voices.write_bytes(b'synthetic')
            onnx = KokoroOnnxBackend(model_path=model, voices_path=voices, engine_factory=lambda *args: Engine())
            apple = KokoroPythonBackend(pipeline_factory=lambda: pipeline)
            table = {'1,234':'1, 234', '1e-7':'1e-7', '+0.5':'+0.5', '−0.5':'−0.5', '**Hello** 你好，world！':'Hello, world!', '[word](/fake/)':'[word](/fake/)'}
            for raw, expected in table.items():
                self.assertEqual(clean_text_for_speech(raw), expected)
                errors = {'1e-7':'UNSUPPORTED_ENGLISH_NUMBER', '−0.5':'UNSUPPORTED_ENGLISH_NUMBER', '[word](/fake/)':'UNSUPPORTED_ENGLISH_TOKEN'}
                for backend in (onnx, apple):
                    if backend is onnx and raw in errors:
                        count = len(seen)
                        with self.assertRaisesRegex(BackendInputError, '^'+errors[raw]+'$'):
                            backend.synthesize(raw, 'af_heart', 1.0)
                        self.assertEqual(len(seen), count)
                    else:
                        result = backend.synthesize(raw, 'af_heart', 1.0)
                        self.assertEqual(seen[-1][1], expected)
                        self.assertEqual(result['sampleRate'], 24000)
            count = len(seen)
            for backend in (onnx, apple):
                with self.assertRaises(BackendInputError):
                    backend.synthesize('中文', 'af_heart', 1.0)
            self.assertEqual(len(seen), count)

if __name__ == "__main__":
    unittest.main()
