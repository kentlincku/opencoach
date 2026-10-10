"""Cold imports and pure admission must not initialize optional speech stacks."""
import subprocess
import sys
import unittest


class BackendImportsTest(unittest.TestCase):
    def test_cold_imports_and_preflight_without_optional_dependencies(self):
        code = r'''
import importlib.abc, sys
blocked = {'numpy','inflect','regex','addict','spacy','torch','transformers','onnxruntime',
           'kokoro','kokoro_onnx','misaki','faster_whisper','mlx_whisper','phonemizer',
           'espeakng_loader','av','num2words','voice_practice_speech_vendor'}
class Guard(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in blocked:
            raise AssertionError('eager optional dependency: '+fullname)
sys.meta_path.insert(0, Guard())
from native.python.voice_runtime import english_numbers, english_g2p, backend_registry, onnx_engine
from native.python.voice_runtime.backends import kokoro_onnx, kokoro_python, faster_whisper, mlx_whisper
from native.python.voice_runtime.backends.base import BackendInputError
assert english_g2p.preflight('-0.00').number_spans == ((0,5,'-0.00',None,False),)
assert english_g2p.preflight('RTX4070').identifier_spans == ((0,7,'RTX4070'),)
try:
    english_g2p.preflight('1e-7')
except BackendInputError as e:
    assert e.code == 'UNSUPPORTED_ENGLISH_NUMBER'
else:
    raise AssertionError('numeric admission missing')
assert not (blocked & set(sys.modules))
print('COLD_IMPORT_AND_PURE_PREFLIGHT_PASS')
'''
        proc = subprocess.run([sys.executable, '-B', '-c', code], capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('COLD_IMPORT_AND_PURE_PREFLIGHT_PASS', proc.stdout)

    def test_real_private_root_metadata_and_repeated_health_are_cold(self):
        code = r'''
import builtins, importlib.abc, os, sys, tempfile
from pathlib import Path
from unittest.mock import patch
blocked = {'numpy', 'inflect', 'regex', 'addict', 'spacy', 'torch', 'transformers',
           'onnxruntime', 'kokoro', 'kokoro_onnx', 'misaki', 'faster_whisper', 'mlx_whisper',
           'phonemizer', 'espeakng_loader', 'av', 'num2words', 'voice_practice_speech_vendor'}
class Guard(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if '.' in fullname and fullname.split('.')[0] in blocked:
            raise AssertionError('heavy submodule discovery: ' + fullname)
sys.meta_path.insert(0, Guard())
from native.python.voice_runtime.backend_registry import BackendRegistry
from native.python.voice_runtime import server
with tempfile.TemporaryDirectory() as temp:
    model, voices = Path(temp)/'model', Path(temp)/'voices'
    model.touch(); voices.touch()
    with patch.dict(os.environ, {'VOICE_KOKORO_ONNX_MODEL': str(model),
                                'VOICE_KOKORO_ONNX_VOICES': str(voices),
                                'VOICE_STT_BACKEND': 'auto', 'VOICE_TTS_BACKEND': 'auto'}):
        registry = BackendRegistry(platform_name='win32', arch_name='x64')
    assert registry.selected_stt == 'faster-whisper'
    assert registry.selected_tts == 'kokoro-onnx'
    assert not (blocked & set(sys.modules)), blocked & set(sys.modules)
    def forbidden(*args, **kwargs):
        raise AssertionError('cold health performed work')
    with patch.object(server, 'backend_registry', registry), \
         patch('os.stat', forbidden), patch('builtins.open', forbidden), \
         patch('importlib.util.find_spec', forbidden), patch.object(builtins, '__import__', forbidden):
        for _ in range(3):
            health = server.dispatch('runtime.health', {})
            assert health['ready'] and health['executionProvider'] is None
            assert server.dispatch('runtime.probe', {})['executable']
    assert registry._tts is None and registry._stt is None
    assert not (blocked & set(sys.modules))
print('REAL_INERT_PRIVATE_METADATA_COLD_HEALTH_PASS')
'''
        proc = subprocess.run([sys.executable, '-B', '-c', code], capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('REAL_INERT_PRIVATE_METADATA_COLD_HEALTH_PASS', proc.stdout)


if __name__ == '__main__':
    unittest.main()
