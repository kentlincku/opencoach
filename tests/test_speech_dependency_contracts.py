"""Pinned source contracts. No native inference or real dictionary/model admission.

Set SPEECH_SOURCE_DIR to the offline source bundle accepted by the builder.
SPEECH_UNPATCHED=1 is the normative upstream RED control for the AST seam tests.
AST execution below is explicitly separate from full generated-module imports.
The full-import lane needs real NumPy; external/native boundaries are declared
as doubles in that test. SPEECH_VENDOR_BUILD can bind it to a durable code-only
build, otherwise the real offline builder supplies the artifact. No model inference
or resource admission is claimed. Temporary files use the caller's owned TMPDIR.
No network/install is used.
"""
import ast
import __future__
import hashlib
import inspect
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCES = Path(os.environ['SPEECH_SOURCE_DIR']) if 'SPEECH_SOURCE_DIR' in os.environ else None
PATCHES = {'kokoro_onnx': 'kokoro-onnx-0.6.1-explicit-tokenizer.patch',
           'misaki': 'misaki-e820629-offline-injection.patch',
           'faster_whisper': 'faster-whisper-1.2.1-array-only.patch'}


def execute_nodes(text, names, globals_=None):
    """Trusted source-node execution, NOT a full package/native import claim."""
    tree = ast.parse(text)
    nodes = [n for n in tree.body if getattr(n, 'name', None) in names]
    env = dict(globals_ or {})
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<pinned-source>', 'exec',
                 flags=__future__.annotations.compiler_flag), env)
    return env


class SourceContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if SOURCES is None:
            raise unittest.SkipTest('offline pinned sources: set SPEECH_SOURCE_DIR')
        cls.temporary = tempfile.TemporaryDirectory(prefix='speech-contract-')
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.stage = Path(cls.temporary.name)
        with zipfile.ZipFile(SOURCES / 'kokoro_onnx-0.6.1-py3-none-any.whl') as archive:
            assert hashlib.sha256(archive.filename and Path(archive.filename).read_bytes()).hexdigest() == '50c8de4950d601df41428ee5462a48c8a78bef441bf671f2492e070ef44d8a32'
            for name in archive.namelist():
                if name.startswith('kokoro_onnx/') and name.endswith('.py'):
                    target = cls.stage / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(name))
        shutil.copytree(SOURCES / 'misaki/misaki', cls.stage / 'misaki')
        shutil.copytree(SOURCES / 'faster-whisper/faster_whisper', cls.stage / 'faster_whisper')
        shutil.copyfile(SOURCES / 'faster-whisper/requirements.txt', cls.stage / 'requirements.txt')
        if os.environ.get('SPEECH_UNPATCHED') != '1':
            for patch in PATCHES.values():
                path = ROOT / 'patches' / patch
                if path.exists():
                    # Independent exact-position patch oracle; host has no patch tool.
                    sections = re.split(r'(?m)^--- a/', path.read_text())[1:]
                    for section in sections:
                        lines = section.splitlines(True)
                        name = lines.pop(0).strip()
                        if lines.pop(0) != '+++ b/' + name + '\n':
                            raise AssertionError('patch path mismatch')
                        target = cls.stage / name
                        old = target.read_text().splitlines(True)
                        result, cursor = [], 0
                        while lines:
                            header = lines.pop(0)
                            match = re.fullmatch(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\n', header)
                            if not match:
                                raise AssertionError(header)
                            start = int(match[1]) - 1
                            result.extend(old[cursor:start]); cursor = start
                            while lines and not lines[0].startswith('@@ '):
                                line = lines.pop(0)
                                if line[0] in ' -':
                                    if old[cursor] != line[1:]:
                                        raise AssertionError('non-exact patch context')
                                    cursor += 1
                                if line[0] in ' +':
                                    result.append(line[1:])
                        result.extend(old[cursor:])
                        target.write_text(''.join(result))

    def source(self, package, name):
        return (self.stage / package / name).read_text(encoding='utf-8')

    def misaki_namespace(self):
        # Real pinned MToken; only absent addict's attribute-dict boundary is doubled.
        from dataclasses import dataclass, replace
        import unicodedata
        class AttrDict(dict):
            def __getattr__(self, key):
                return self.get(key)
            def __setattr__(self, key, value):
                self[key] = value
        token = execute_nodes(self.source('misaki', 'token.py'), {'MToken'},
                              {'dataclass': dataclass, 'addict': types.SimpleNamespace(Dict=AttrDict)})['MToken']
        env = dict(dataclass=dataclass, replace=replace, re=re, json=json, Path=Path,
                   unicodedata=unicodedata, MToken=token,
                   subtokenize=lambda text: re.findall(r'[A-Za-z]+|[0-9]+|[^A-Za-z0-9]', text))
        tree = ast.parse(self.source('misaki', 'en.py'))
        tree.body = [n for n in tree.body if not isinstance(n, (ast.Import, ast.ImportFrom, ast.Delete))
                     and getattr(n, 'name', '') != 'make_subtokenize_once'
                     and not (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'subtokenize' for t in n.targets))]
        exec(compile(tree, '<pinned-misaki-with-explicit-dependency-doubles>', 'exec',
                     flags=__future__.annotations.compiler_flag), env)
        return env

    def builder_command(self, output, **overrides):
        import sys
        args = {'kokoro-source':SOURCES/'kokoro_onnx-0.6.1-py3-none-any.whl',
                'misaki-source':SOURCES/'misaki', 'faster-whisper-source':SOURCES/'faster-whisper',
                'output-dir':output}
        args.update(overrides)
        return [sys.executable, '-B', str(ROOT/'scripts/build-speech-vendor.py'),
                *[value for key, val in args.items() for value in ('--'+key,str(val))]]

    def test_real_m_known_acronym_and_silver_precede_spelling(self):
        # V2 conditional regression: actual module + inflect, no lexical/import doubles.
        import inflect
        from native.python.voice_runtime.english_numbers import EnglishNumberFormatter
        from voice_practice_speech_vendor.misaki.en import G2P
        class NLP:
            pipe_names = ['tok2vec', 'tagger']
            def __call__(self, text):
                return [types.SimpleNamespace(idx=0,text=text,tag_='NNP',whitespace_='')]
        gold = self.stage/'real-gold.json'; silver = self.stage/'real-silver.json'
        gold.write_text(json.dumps({'U.S.A.':{'DEFAULT':'nOn','NOUN':'wɜɹld'}, 'nasa':'nOn'}))
        silver.write_text(json.dumps({'NASA':'nOn'}))
        def no_spelling(word):
            raise AssertionError('known dictionary entry incorrectly spelled')
        g = G2P(nlp=NLP(), number_formatter=EnglishNumberFormatter(engine=inflect.engine()),
                lexicon_paths=(gold,silver), spell_ascii=no_spelling, render_identifier=no_spelling)
        for text, expected in [('U.S.A.','wˈɜɹld'), ('NASA','nˈOn')]:
            with self.subTest(text=text):
                self.assertEqual(g(text)[0], expected)
        # Existing one-argument injection retains its exact normalized arguments.
        legacy = Mock(return_value='n')
        g.lexicon.spell_ascii = legacy
        self.assertEqual(g('Q.Z.')[0], 'n')
        legacy.assert_called_once_with('QZ')
        legacy.reset_mock()
        self.assertEqual(g('ZZ')[0], 'n')
        legacy.assert_called_once_with('zz')

    def test_builder_real_deterministic_code_only_wheel(self):
        self.assertTrue((ROOT/'scripts/build-speech-vendor.py').is_file(),
                        'offline source-pinned builder is not implemented')
        outputs=[]
        for name in ('build-a','build-b'):
            out=self.stage/name
            proc=subprocess.run(self.builder_command(out), text=True,capture_output=True)
            self.assertEqual(proc.returncode,0,proc.stdout+proc.stderr)
            wheels=list(out.glob('*.whl')); self.assertEqual(len(wheels),1)
            outputs.append(wheels[0].read_bytes())
            with zipfile.ZipFile(wheels[0]) as wheel:
                names=wheel.namelist()
                self.assertTrue(all(n.startswith(('voice_practice_speech_vendor/', 'voice_practice_speech_vendor-')) for n in names))
                provenance=json.loads(wheel.read('voice_practice_speech_vendor/provenance.json'))
                self.assertTrue(provenance['code_only']); self.assertFalse(provenance['resource_ready'])
                self.assertEqual(set(provenance['patches']),set(PATCHES.values()))
                self.assertEqual(provenance['sources']['misaki']['revision'],'e820629b96334db28227df37f280e4836d46fadb')
                self.assertFalse(any(n.endswith(('.onnx','.bin')) or '/resources/' in n for n in names))
                import base64,csv,io
                record=next(n for n in names if n.endswith('.dist-info/RECORD'))
                rows=list(csv.reader(io.StringIO(wheel.read(record).decode())))
                self.assertEqual({r[0] for r in rows},set(names))
                for member,digest,size in rows:
                    if member==record:
                        self.assertEqual((digest,size),('','')); continue
                    data=wheel.read(member)
                    self.assertEqual(int(size),len(data))
                    self.assertEqual(digest,'sha256='+base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('='))
                for pkg,src in [('misaki',SOURCES/'misaki/LICENSE'),('faster-whisper',SOURCES/'faster-whisper/LICENSE')]:
                    self.assertEqual(wheel.read('voice_practice_speech_vendor/notices/'+pkg+'-LICENSE'),src.read_bytes())
                for member in names:
                    if member.endswith('.py'):
                        tree=ast.parse(wheel.read(member))
                        for node in ast.walk(tree):
                            if isinstance(node,ast.ImportFrom) and node.level==0:
                                self.assertNotIn((node.module or '').split('.')[0],('kokoro_onnx','misaki','faster_whisper','av','num2words','phonemizer','espeakng_loader'))
        self.assertEqual(outputs[0],outputs[1], 'build paths/timestamps must not affect wheel bytes')
        if os.environ.get('SPEECH_VENDOR_BUILD'):
            durable = Path(os.environ['SPEECH_VENDOR_BUILD'])
            receipt = json.loads((durable/'build-result.json').read_text())
            self.assertEqual(outputs[0], (durable/receipt['wheel']).read_bytes())
        # Same builder trust boundary, not an editable adjacent manifest.
        wrong = self.stage/'wrong.whl'
        wrong.write_bytes((SOURCES/'kokoro_onnx-0.6.1-py3-none-any.whl').read_bytes()+b'tamper')
        proc = subprocess.run(self.builder_command(self.stage/'bad-archive', **{'kokoro-source':wrong}),capture_output=True,text=True)
        self.assertNotEqual(proc.returncode,0); self.assertIn('SOURCE_HASH_MISMATCH',proc.stderr)
        for fault in ('missing','modified','extra','symlink'):
            tree=self.stage/('source-'+fault); shutil.copytree(SOURCES/'misaki',tree)
            member=tree/'misaki/token.py'
            if fault=='missing': member.unlink()
            elif fault=='modified': member.write_text(member.read_text()+'\n# changed\n')
            elif fault=='extra': (tree/'manifest.json').write_text('{"trusted":true}')
            else:
                member.unlink(); member.symlink_to(SOURCES/'misaki/misaki/token.py')
            out=self.stage/('rejected-'+fault)
            proc=subprocess.run(self.builder_command(out,**{'misaki-source':tree}),capture_output=True,text=True)
            self.assertNotEqual(proc.returncode,0,(fault,proc.stdout)); self.assertFalse(out.exists())
        proc=subprocess.run(self.builder_command(self.stage/'build-a'),capture_output=True,text=True)
        self.assertNotEqual(proc.returncode,0); self.assertIn('OUTPUT_EXISTS',proc.stderr)


    def test_builder_finite_validator_negatives(self):
        # Validator-unit fixtures, never counterfeit upstream accepted by build().
        import importlib.util
        spec = importlib.util.spec_from_file_location('speech_builder_test', ROOT/'scripts/build-speech-vendor.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        name = 'misaki/en.py'
        valid = b'--- a/misaki/en.py\n+++ b/misaki/en.py\n@@ -1 +1 @@\n-old\n+new\n'
        files = {name: b'old\n'}
        self.assertEqual(len(builder.apply_patch(files, valid, {name})), 1)
        self.assertEqual(files[name], b'new\n')
        cases = [
            (valid.replace(b'-old', b'-wrong'), 'PATCH_CONTEXT_MISMATCH'),
            (valid.replace(b'@@ -1 +1', b'@@ -3 +1'), 'PATCH_POSITION_MISMATCH'),
            (valid.replace(b'@@ -1 +1', b'@@ -1 +2'), 'PATCH_POSITION_MISMATCH'),
            (valid.replace(b'@@ -1 +1', b'@@ -1,2 +1'), 'PATCH_CONTEXT_MISMATCH'),
            (valid.replace(b'+++ b/misaki/en.py', b'+++ b/misaki/token.py'), 'PATCH_PATH_INVALID'),
            (valid.replace(b'misaki/en.py', b'../escape.py'), 'MALFORMED_SOURCE_PATH'),
        ]
        for data, code in cases:
            with self.subTest(code=code, data=data), self.assertRaisesRegex(ValueError, code):
                builder.apply_patch({name: b'old\n'}, data, {name})
        self.assertEqual(builder.safe_name(name), name)
        for path in ('', '/absolute', '../escape', 'a//b', 'a/./b', 'a\\b', 'C:drive', 'a\x00b'):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'MALFORMED_SOURCE_PATH'):
                builder.safe_name(path)
        proc = subprocess.run(self.builder_command(self.stage/'relative-source-rejected',
                              **{'misaki-source':Path('relative-source')}), capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('MALFORMED_SOURCE_PATH', proc.stderr)
        members = {'faster_whisper/audio.py', 'faster_whisper/transcribe.py'}
        relocated, changes, imports = builder.relocate('faster_whisper/transcribe.py',
            b'from faster_whisper.audio import pad_or_trim\nimport numpy\n', members)
        self.assertIn(b'voice_practice_speech_vendor.faster_whisper.audio', relocated)
        self.assertEqual(len(changes), 1)
        self.assertEqual(imports, ['faster_whisper.audio', 'numpy'])
        for snippet, code in [
            (b'import av\n', 'UNEXPECTED_IMPORT_ROOT'),
            (b'from faster_whisper.missing import X\n', 'UNRESOLVED_IMPORT_MEMBER'),
            (b'from ...audio import X\n', 'UNEXPECTED_IMPORT_ROOT'),
            (b'__import__("av")\n', 'UNRESOLVED_DYNAMIC_IMPORT'),
            (b'import importlib\nimportlib.import_module("av")\n', 'UNRESOLVED_DYNAMIC_IMPORT'),
        ]:
            with self.subTest(snippet=snippet), self.assertRaisesRegex(ValueError, code):
                builder.relocate('faster_whisper/transcribe.py', snippet, members)

    def test_real_private_imports_and_numpy_lane(self):
        """A fresh owned interpreter preserves the strict pristine-import contract."""
        import sys
        script = (
            "import sys; sys.path.insert(0, sys.argv[1]); "
            "from test_speech_dependency_contracts import SourceContracts; "
            "SourceContracts.setUpClass()\n"
            "try:\n"
            "    SourceContracts('_verify_private_imports_and_numpy_lane').debug()\n"
            "finally:\n"
            "    SourceContracts.doClassCleanups()\n"
        )
        proc = subprocess.run([sys.executable, '-B', '-c', script, str(ROOT/'tests')],
                              capture_output=True, text=True, timeout=240)
        print(proc.stdout, end='')
        self.assertEqual(proc.returncode, 0, proc.stdout+proc.stderr)
        self.assertIn('PRIVATE_NUMPY_LANE ', proc.stdout)

    def _verify_private_imports_and_numpy_lane(self):
        """Full generated modules; only external dependencies/model boundaries doubled."""
        import importlib
        import importlib.abc
        import socket
        import sys
        import urllib.request
        import http.client
        from contextlib import ExitStack
        from unittest.mock import patch
        # Reuse a durable artifact when explicitly supplied; otherwise build real sources.
        supplied = os.environ.get('SPEECH_VENDOR_BUILD')
        out = Path(supplied) if supplied else self.stage/'import-build'
        if not supplied:
            proc = subprocess.run(self.builder_command(out), capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stdout+proc.stderr)
        receipt = json.loads((out/'build-result.json').read_text())
        wheel_path = out/receipt['wheel']
        self.assertEqual(hashlib.sha256(wheel_path.read_bytes()).hexdigest(), receipt['sha256'])
        self.assertEqual(wheel_path.stat().st_size, receipt['bytes'])
        with zipfile.ZipFile(wheel_path) as archive:
            wheel_files = {n:archive.read(n) for n in archive.namelist()}
        provenance = json.loads(wheel_files['voice_practice_speech_vendor/provenance.json'])
        self.assertEqual(provenance['builderSha256'], hashlib.sha256((ROOT/'scripts/build-speech-vendor.py').read_bytes()).hexdigest())
        for name in PATCHES.values():
            self.assertEqual(provenance['patches'][name]['sha256'], hashlib.sha256((ROOT/'patches'/name).read_bytes()).hexdigest())
        anchor = out/'source'
        for name, data in wheel_files.items():
            self.assertEqual((anchor/name).read_bytes(), data)
        prefix = 'voice_practice_speech_vendor'
        banned = {'av', 'phonemizer', 'phonemizer_fork', 'espeakng_loader', 'num2words',
                  'kokoro_onnx', 'misaki', 'faster_whisper', 'spacy', 'soundfile'}
        self.assertFalse(any(n.split('.')[0] in banned or n == prefix or n.startswith(prefix+'.') for n in sys.modules))
        blocked = Mock(side_effect=AssertionError('TEST_LANE_NETWORK_OR_IMPLICIT_LOADER_BLOCKED'))
        class RejectImports(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                if fullname.split('.')[0] in banned:
                    raise ImportError('TEST_LANE_FORBIDDEN_IMPORT:'+fullname)
        finder = RejectImports()
        def module(name, **attrs):
            result = types.ModuleType(name)
            result.__dict__.update(attrs)
            return result
        class AttrDict(dict):
            def __getattr__(self, key):
                return self.get(key)
            def __setattr__(self, key, value):
                self[key] = value
        class NativeBoundary(Exception):
            pass
        ct2_model = types.SimpleNamespace(is_multilingual=False, device='cpu',
                         encode=Mock(side_effect=NativeBoundary('CT2_ENCODE_NOT_RUN')))
        ct2_factory = Mock(return_value=ct2_model)
        class StorageView:
            @staticmethod
            def from_array(array):
                return array  # explicit CT2 storage double, real ndarray retained
        class TokenizerDouble:
            from_file = Mock(return_value=object())
            from_buffer = blocked
            from_pretrained = blocked
        # regex Unicode implementation is absent: only import/ASCII word boundary is
        # doubled. This does NOT establish true regex/spaCy linguistic semantics.
        regex_double = module('regex', compile=lambda pattern: pattern,
                              findall=lambda pattern, text: re.findall(r'[A-Za-z]+|[0-9]+|[^A-Za-z0-9]', text))
        progress = Mock(return_value=Mock())
        doubles = {
            'onnxruntime': module('onnxruntime', InferenceSession=blocked),
            'ctranslate2': module('ctranslate2', StorageView=StorageView,
                                 models=types.SimpleNamespace(Whisper=ct2_factory, WhisperGenerationResult=object)),
            'tokenizers': module('tokenizers', Tokenizer=TokenizerDouble),
            'huggingface_hub': module('huggingface_hub', snapshot_download=blocked, hf_hub_download=blocked),
            'tqdm': module('tqdm', tqdm=progress),
            'tqdm.auto': module('tqdm.auto', tqdm=progress),
            'addict': module('addict', Dict=AttrDict),
            'regex': regex_double,
        }
        origins = {}
        with ExitStack() as stack:
            # Avoid patch.dict(sys.modules) undoing unrelated NumPy imports.
            for name, double in doubles.items():
                previous = sys.modules.get(name)
                sys.modules[name] = double
                def restore(name=name, previous=previous):
                    if previous is None:
                        sys.modules.pop(name, None)
                    else:
                        sys.modules[name] = previous
                stack.callback(restore)
            sys.meta_path.insert(0, finder)
            stack.callback(sys.meta_path.remove, finder)
            sys.path.insert(0, str(anchor))
            stack.callback(sys.path.remove, str(anchor))
            def remove_vendor():
                for name in list(sys.modules):
                    if name == prefix or name.startswith(prefix+'.'):
                        del sys.modules[name]
            stack.callback(remove_vendor)
            for target in ('socket.socket.connect', 'socket.socket.connect_ex', 'socket.create_connection',
                           'urllib.request.urlopen', 'http.client.HTTPConnection.connect', 'http.client.HTTPSConnection.connect'):
                stack.enter_context(patch(target, blocked))
            # Test the fences themselves, then count only unintended boundary calls.
            for name in sorted(banned):
                with self.assertRaisesRegex(ImportError, 'TEST_LANE_FORBIDDEN_IMPORT'):
                    importlib.import_module(name)
            with self.assertRaisesRegex(AssertionError, 'TEST_LANE_NETWORK'):
                socket.create_connection(('invalid.example', 443))
            blocked.reset_mock()
            import numpy as np
            self.assertIsInstance(np, types.ModuleType)
            self.assertTrue(Path(np.__file__).is_file())
            for name in sorted(n for n in wheel_files if n.endswith('.py')):
                dotted = name[:-3].replace('/', '.')
                if dotted.endswith('.__init__'):
                    dotted = dotted[:-9]
                loaded = importlib.import_module(dotted)
                expected = (anchor/name).resolve()
                self.assertEqual(Path(loaded.__file__).resolve(), expected)
                self.assertEqual(Path(loaded.__spec__.origin).resolve(), expected)
                self.assertEqual(expected.read_bytes(), wheel_files[name])
                origins[dotted] = str(expected)
            audio = importlib.import_module(prefix+'.faster_whisper.audio')
            array = np.array([[1, 2, 3], [4, 5, 6]], dtype=np.float32)
            np.testing.assert_array_equal(audio.pad_or_trim(array, 5), [[1,2,3,0,0],[4,5,6,0,0]])
            np.testing.assert_array_equal(audio.pad_or_trim(array, 2), [[1,2],[4,5]])
            np.testing.assert_array_equal(audio.pad_or_trim(array, 3, axis=0), [[1,2,3],[4,5,6],[0,0,0]])
            self.assertIs(audio.pad_or_trim(array, 3), array)
            F = importlib.import_module(prefix+'.faster_whisper')
            local = self.stage/'full-import-local-model'; local.mkdir()
            (local/'tokenizer.json').write_text('{}')  # inert file; parser is declared double
            obj = F.WhisperModel(str(local), local_files_only=True)
            self.assertIs(obj.model, ct2_model)
            waveform = np.sin(np.arange(1600, dtype=np.float32)*np.float32(0.05))
            segments, info = obj.transcribe(waveform, language='en', vad_filter=False,
                                           suppress_tokens=[], chunk_length=1)
            self.assertAlmostEqual(info.duration, 0.1)
            # Consume real generator until the explicitly stopped native boundary.
            with self.assertRaisesRegex(NativeBoundary, 'CT2_ENCODE_NOT_RUN'):
                list(segments)
            ct2_model.encode.assert_called_once()
            features = ct2_model.encode.call_args.args[0]
            self.assertEqual(features.shape, (1, 80, 3000))
            self.assertEqual(features.dtype, np.float32)
            self.assertTrue(np.isfinite(features).all())
            self.assertGreater(float(np.abs(features).sum()), 0)
            for value in ('file.wav', object()):
                with self.assertRaisesRegex(ValueError, 'ARRAY_INPUT_REQUIRED'):
                    obj.transcribe(value, language='en', vad_filter=False)
            (local/'tokenizer.json').unlink()
            ct2_factory.reset_mock()
            with self.assertRaisesRegex(ValueError, 'LOCAL_TOKENIZER_REQUIRED'):
                F.WhisperModel(str(local), local_files_only=True)
            ct2_factory.assert_not_called()
            vad = importlib.import_module(prefix+'.faster_whisper.vad')
            with self.assertRaisesRegex(ValueError, 'VAD_RESOURCE_INVALID'):
                vad.get_vad_model()
            K = importlib.import_module(prefix+'.kokoro_onnx')
            model = self.stage/'inert-k-model'; model.write_bytes(b'NOT_A_MODEL')
            voices = self.stage/'inert-voices.npz'
            np.savez(voices, test=np.array([[0.1, 0.2]], dtype=np.float32))
            session = types.SimpleNamespace(
                get_inputs=lambda: [types.SimpleNamespace(name=n, type=t) for n,t in
                    [('tokens','tensor(int64)'),('style','tensor(float)'),('speed','tensor(float)')]],
                get_outputs=lambda: [types.SimpleNamespace(name='audio')],
                get_modelmeta=lambda: types.SimpleNamespace(custom_metadata_map={
                    'kokoro_config':'{"vocab":{"_":0,"a":1}}'}),
                run=Mock(return_value=[np.array([[0.25, -0.25]], dtype=np.float32)]))
            metadata = importlib.import_module(prefix+'.kokoro_onnx.session')
            self.assertEqual(metadata.embedded_vocab(session), {'_':0,'a':1})
            tokenizer = types.SimpleNamespace(vocab={'_':0,'a':1}, phonemize=lambda *a:'a',
                        tokenize=Mock(return_value=[1]), known=lambda p:p)
            kokoro = K.Kokoro.from_session(session, str(voices), model_path=str(model), tokenizer=tokenizer)
            try:
                self.assertIs(kokoro.sess, session)
                samples, rate = kokoro._create_audio('a', kokoro.get_voice_style('test'), 1.0)
                np.testing.assert_array_equal(samples, [0.25,-0.25])
                self.assertEqual(rate, 24000)
                session.run.assert_called_once()
                inputs = session.run.call_args.args[1]
                np.testing.assert_array_equal(inputs['tokens'], [[0,1,0]])
                self.assertEqual(inputs['tokens'].dtype, np.int64)
                np.testing.assert_allclose(inputs['style'], [0.1,0.2])
                self.assertEqual(inputs['speed'].dtype, np.float32)
            finally:
                kokoro.voices.close()
            M = importlib.import_module(prefix+'.misaki.en')
            gold = self.stage/'full-import-gold.json'; gold.write_text('{"hello":"həlu"}')
            silver = self.stage/'full-import-silver.json'; silver.write_text('{}')
            nlp = Mock(return_value=[types.SimpleNamespace(text='hello',idx=0,tag_='NN',whitespace_='')])
            nlp.pipe_names = ['tok2vec','tagger']
            g = M.G2P(nlp=nlp, number_formatter=Mock(), lexicon_paths=(gold,silver),
                      spell_ascii=blocked, render_identifier=blocked)
            self.assertEqual(g('hello')[0], 'həlu')
            blocked.assert_not_called()
            self.assertFalse(any(n.split('.')[0] in banned for n in sys.modules))
            print('PRIVATE_NUMPY_LANE '+json.dumps({'wheel_sha256':receipt['sha256'],
                'python':sys.version.split()[0], 'numpy':np.__version__, 'numpy_origin':np.__file__,
                'module_origins':origins, 'external_doubles':sorted(doubles),
                'F':'real ndarray -> FeatureExtractor -> generate_segments -> pad_or_trim -> encode; CT2 stopped',
                'K':'real from_session -> np.load -> _create_audio -> _infer -> explicit session.run double',
                'M':'full module -> G2P known-word with explicit NLP/regex/addict doubles',
                'native_models_resources':'NOT_RUN'}, sort_keys=True))

    def test_f_array_only_and_local_tokenizer_gate(self):
        audio = self.source('faster_whisper', 'audio.py')
        self.assertNotIn('import av', audio, 'real F still eagerly imports PyAV')
        decode = execute_nodes(audio, {'decode_audio'})['decode_audio']
        for value in ('sample.wav', object(), None):
            with self.assertRaisesRegex(ValueError, 'ARRAY_INPUT_REQUIRED'):
                decode(value)
        factory = Mock(return_value=types.SimpleNamespace(is_multilingual=False))
        hub = Mock(side_effect=AssertionError('network/download boundary reached'))
        tokenizers = types.SimpleNamespace(Tokenizer=types.SimpleNamespace(from_file=Mock(return_value='local'),
                      from_buffer=Mock(), from_pretrained=hub))
        env = execute_nodes(self.source('faster_whisper', 'transcribe.py'), {'WhisperModel'},
                            {'os':os, 'json':json, 'get_logger':Mock(),
                             'ctranslate2':types.SimpleNamespace(models=types.SimpleNamespace(Whisper=factory)),
                             'tokenizers':tokenizers, 'download_model':hub,
                             'FeatureExtractor':lambda **kw: types.SimpleNamespace(hop_length=160,sampling_rate=16000),
                             '_LANGUAGE_CODES':{'en','fr'}})
        F = env['WhisperModel']; model = self.stage / 'local-model'; model.mkdir()
        tokenizer = model / 'tokenizer.json'; tokenizer.write_text('{}')
        obj = F(str(model), local_files_only=True)
        self.assertEqual(obj.hf_tokenizer,'local'); self.assertEqual(obj.supported_languages,['en'])
        for value, extra in [('tiny',{}), ('relative',{}), (str(model/'absent'),{}),
                             (str(model),{'files':{}})]:
            factory.reset_mock()
            with self.subTest(value=value,extra=extra), self.assertRaisesRegex(ValueError,'LOCAL_MODEL_REQUIRED'):
                F(value,local_files_only=True,**extra)
            factory.assert_not_called()
        tokenizer.unlink()
        with self.assertRaisesRegex(ValueError,'LOCAL_TOKENIZER_REQUIRED'):
            F(str(model),local_files_only=True)
        tokenizer.write_text('{}')
        def remove_tokenizer(*args, **kwargs):
            tokenizer.unlink(); return types.SimpleNamespace(is_multilingual=False)
        factory.side_effect = remove_tokenizer
        with self.assertRaisesRegex(ValueError,'LOCAL_TOKENIZER_REQUIRED'):
            F(str(model),local_files_only=True)
        hub.assert_not_called()
        self.assertIn('isinstance(audio, np.ndarray)', self.source('faster_whisper','transcribe.py'))
        self.assertNotIn('av', (self.stage/'requirements.txt').read_text().splitlines())

    def test_f_vad_private_resource_path(self):
        text = self.source('faster_whisper','vad.py')
        self.assertNotIn('get_assets_path',text, 'VAD needs deterministic package resource anchor')
        import functools
        root = self.stage/'faster_whisper'
        factory = Mock(return_value='vad-double')
        resources = types.SimpleNamespace(files=lambda package: root)
        get = execute_nodes(text, {'get_vad_model'}, {'functools':functools, 'Path':Path,
                     'resources':resources, '__package__':'faster_whisper', 'SileroVADModel':factory})['get_vad_model']
        with self.assertRaisesRegex(ValueError,'VAD_RESOURCE_INVALID'):
            get()
        factory.assert_not_called()
        asset = root/'assets/silero_vad_v6.onnx'; asset.parent.mkdir(); asset.write_bytes(b'inert-path-fixture-not-model')
        self.assertEqual(get(),'vad-double'); factory.assert_called_once_with(str(asset))
        get.cache_clear(); asset.unlink(); asset.symlink_to(self.stage/'requirements.txt')
        with self.assertRaisesRegex(ValueError,'VAD_RESOURCE_INVALID'):
            get()

    def test_m_dedicated_spans_dispatch_before_mixed_alias_and_atomic_spelling(self):
        env = self.misaki_namespace(); G = env['G2P']
        self.assertIn('identifier_spans', inspect.signature(G.__call__).parameters,
                      'real M lacks dedicated span dispatcher')
        gold = self.stage / 'span-gold.json'; silver = self.stage / 'span-silver.json'
        gold.write_text(json.dumps({'hello':'həlu','minus':'i','zero':'i','point':'i','five':'i','plus':'i'}))
        silver.write_text('{}')
        # Offset-bearing deterministic nlp double intentionally splits every character.
        class NLP:
            pipe_names = ['tok2vec', 'tagger']
            def __call__(self, text):
                return [types.SimpleNamespace(text=m.group(), idx=m.start(), tag_='NN',
                         whitespace_=text[m.end():m.end()+1] if text[m.end():m.end()+1].isspace() else '')
                        for m in re.finditer(r'[^\s]', text)]
        formatter = Mock(); formatter.decimal.return_value = 'zero point five'
        spell = Mock(return_value='i i'); render = Mock(return_value='i i i')
        g = G(nlp=NLP(), number_formatter=formatter, lexicon_paths=(gold,silver),
              spell_ascii=spell, render_identifier=render)
        text = '-0.50 RTX4070'
        phonemes, tokens = g(text, number_spans=((0,5,'-0.50',None,False),),
                            identifier_spans=((6,13,'RTX4070'),))
        formatter.decimal.assert_called_once_with('0.50')
        render.assert_called_once_with('RTX4070')
        self.assertEqual([tk.text for tk in tokens], ['-0.50','RTX4070'])
        self.assertEqual(tokens[0].whitespace, ' ')
        self.assertNotIn('❓', phonemes); spell.assert_not_called()
        for word in ('5G','R2D2','x2y','AB007','E5'):
            render.reset_mock(); g(word, identifier_spans=((0,len(word),word),))
            render.assert_called_once_with(word)
        for word, code in [('21st2','UNSUPPORTED_ENGLISH_NUMBER'),('1e7','UNSUPPORTED_ENGLISH_NUMBER'),
                           ('1e','UNSUPPORTED_ENGLISH_NUMBER'),('A' * 64 + '1','ENGLISH_SPELLING_LIMIT'),
                           ('A' + '0'*19,'ENGLISH_NUMBER_LIMIT'),('123','UNSUPPORTED_ENGLISH_TOKEN')]:
            with self.subTest(word=word), self.assertRaisesRegex(ValueError, code):
                g(word, identifier_spans=((0,len(word),word),))
        for ns, ids in [(((0,5,'-0.50',None,False),),((0,5,'-0.50'),)),
                        ((),((6,13,'RTX4071'),)), ((),((7,13,'TX4070'),)),
                        (((0,5,'0.50',None,False),),())]:
            with self.assertRaisesRegex(ValueError, 'ENGLISH_SPAN_INVALID'):
                g(text, number_spans=ns, identifier_spans=ids)
        with self.assertRaisesRegex(ValueError, 'ENGLISH_CONFIGURATION_INVALID'):
            g('hello', preprocess=True)
        # The original early get_NNP route must use the same explicit speller.
        g.lexicon.get_NNP('U.S.A.')
        spell.assert_called_with('USA')
        for word in ("bad'name", 'café', 'R2D2'):
            with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_ENGLISH_TOKEN'):
                g.lexicon.get_NNP(word)
        class WordNLP(NLP):
            def __call__(self, text):
                return [types.SimpleNamespace(text=text, idx=0, tag_='NN', whitespace_='')]
        g.nlp = WordNLP()
        spell.reset_mock()
        self.assertEqual(g('hello')[0], 'həlu'); spell.assert_not_called()
        g('zorvex'); spell.assert_called_once_with('zorvex')

    def test_m_injected_lexicon_preserves_number_lexemes(self):
        env = self.misaki_namespace()
        Lexicon = env['Lexicon']
        self.assertIn('number_formatter', inspect.signature(Lexicon).parameters,
                      'real M lacks formatter/resource injection')
        words = 'minus zero point one two three four five six seven eight nine oh twenty dollar dollars cent cents pound pounds penny pence euro euros and first'.split()
        gold = self.stage / 'gold.json'; silver = self.stage / 'silver.json'
        gold.write_text(json.dumps({w: 'i' for w in words})); silver.write_text('{}')
        formatter = Mock()
        formatter.cardinal.return_value = 'one'
        formatter.decimal.return_value = 'zero point two five'
        formatter.digits.return_value = 'zero zero seven'
        formatter.ordinal.return_value = 'first'
        formatter.year.return_value = 'twenty'
        spell = Mock(side_effect=AssertionError('numeric resource must never spell'))
        lex = Lexicon(False, number_formatter=formatter, lexicon_paths=(gold,silver), spell_ascii=spell)
        original_lookup = lex.lookup
        seen = []
        def lookup(word, *args):
            seen.append(word)
            return original_lookup(word, *args)
        lex.lookup = lookup
        for word in ('-0.25', '-0.00', '1.2300', '.25', '0.123456789012345678'):
            seen.clear(); formatter.reset_mock()
            lex.get_number(word, None, True, '')
            formatter.decimal.assert_called_once_with(word.lstrip('-'))
            self.assertEqual(seen.count('minus'), int(word.startswith('-')))
        lex.get_number('007', None, False, '')
        formatter.digits.assert_called_with('007')
        for word, code in [('1e7','UNSUPPORTED_ENGLISH_NUMBER'), ('11st','UNSUPPORTED_ENGLISH_NUMBER'),
                           ('-1st','UNSUPPORTED_ENGLISH_NUMBER'), ('1' * 16,'ENGLISH_NUMBER_LIMIT'),
                           ('0.'+'1'*19,'ENGLISH_NUMBER_LIMIT')]:
            with self.subTest(word=word), self.assertRaisesRegex(ValueError, code):
                lex.get_number(word, None, True, '')
        with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_ENGLISH_NUMBER'):
            lex.get_number('1.234', '$', True, '')
        with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_ENGLISH_NUMBER'):
            lex.get_number('1', None, True, '&')
        del lex.golds['point']
        with self.assertRaisesRegex(ValueError, 'ENGLISH_RESOURCE_INVALID'):
            lex.get_number('0.5', None, True, '')
        spell.assert_not_called()
        text = self.source('misaki', 'en.py')
        for forbidden in ('num2words', 'float(', 'spacy.cli.download', 'open_text'):
            self.assertNotIn(forbidden, text)

    def test_k_padding_metadata_contract(self):
        # Synthetic format fixture, NOT actual model metadata/compatibility proof.
        read = execute_nodes(self.source('kokoro_onnx', 'session.py'), {'embedded_vocab'},
                             {'json': json, 'CONFIG_KEY': 'kokoro_config'})['embedded_vocab']
        def session(vocab):
            return types.SimpleNamespace(get_modelmeta=lambda: types.SimpleNamespace(
                custom_metadata_map={'kokoro_config': json.dumps({'vocab': vocab})}))
        self.assertEqual(read(session({'a': 1})), {'a': 1})
        # No glyph-specific pad convention; 0 is a reserved ID, not a phoneme.
        for pad in ('_', '~'):
            vocab = {pad: 0, 'a': 1, ' ': 2}
            self.assertEqual(read(session(vocab)), vocab)
        for invalid in ({'_': 0}, {}, {'_': False, 'a': 1}, {'_': -1, 'a': 1},
                        {'_': 0, '~': 0, 'a': 1}, {'_': 0, 'a': 1, 'b': 1}):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, 'MALFORMED_KOKORO_METADATA'):
                read(session(invalid))
        # V2/V3 G strict tokenizer must never emit a mapped 0 as a phoneme;
        # K's existing inference owns its boundary padding. No G implementation here.

    def test_k_metadata_missing_is_not_malformed_and_no_implicit_loaders(self):
        text = self.source('kokoro_onnx', 'session.py')
        env = execute_nodes(text, {'embedded_vocab'}, {'json': json, 'CONFIG_KEY': 'kokoro_config'})
        read = env['embedded_vocab']
        session = lambda meta: types.SimpleNamespace(get_modelmeta=lambda: types.SimpleNamespace(custom_metadata_map=meta))
        self.assertIsNone(read(session({})), 'missing metadata must be None, not an empty fallback map')
        self.assertIsNone(read(session({'kokoro_config': '{}'})))
        self.assertEqual(read(session({'kokoro_config': '{"vocab":{"a":1," ":2}}'})), {'a': 1, ' ': 2})
        for raw in ['', 'null', '[]', '{', '{"vocab":{}}', '{"vocab":null}',
                    '{"vocab":{"a":true}}', '{"vocab":{"a":-1}}',
                    '{"vocab":{"aa":1}}', '{"vocab":{"a":0}}',
                    '{"vocab":{"a":1,"b":1}}', '{"vocab":{"a":1,"a":2}}']:
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, 'MALFORMED_KOKORO_METADATA'):
                read(session({'kokoro_config': raw}))
        self.assertNotIn('def create_session', text)
        self.assertNotIn('resolve_providers', text)
        config = self.source('kokoro_onnx', 'config.py')
        self.assertNotIn('DEFAULT_VOCAB', config)
        self.assertNotIn('EspeakConfig', config)
        tokenizer = self.source('kokoro_onnx', 'tokenizer.py')
        self.assertIn('Protocol', tokenizer)
        for forbidden in ('phonemizer', 'espeak', 'ctypes', 'DEFAULT_VOCAB'):
            self.assertNotIn(forbidden, tokenizer)

    def test_k_explicit_tokenizer_same_session_no_constructor(self):
        text = self.source('kokoro_onnx', '__init__.py')
        tree = ast.parse(text)
        klass = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Kokoro')
        method = next(n for n in klass.body if getattr(n, 'name', '') == 'from_session')
        self.assertIn('tokenizer', [a.arg for a in method.args.kwonlyargs],
                      'real upstream K lacks required explicit tokenizer seam')
        self.assertIn('model_path', [a.arg for a in method.args.kwonlyargs])
        env = execute_nodes(text, {'Kokoro'}, {
            'KoKoroConfig': Mock(return_value=Mock()),
            'np': types.SimpleNamespace(load=Mock(return_value='voices')),
            'input_dtypes': lambda session: {'tokens': 'int64'},
        })
        K = env['Kokoro']
        with self.assertRaisesRegex(TypeError, 'from_session'):
            K('model', 'voices')
        session = types.SimpleNamespace(get_outputs=lambda: [])
        tokenizer = types.SimpleNamespace(vocab={'a': 1}, phonemize=lambda *a: 'a',
                                           tokenize=lambda *a: [1], known=lambda p: p)
        instance = K.from_session(session, 'voices', model_path='model', tokenizer=tokenizer)
        self.assertIs(instance.sess, session)
        self.assertIs(instance.tokenizer, tokenizer)
        self.assertNotIn('session._model_path', text)
        self.assertIn('self.sess.run(None, inputs)', text)


if __name__ == '__main__':
    unittest.main(verbosity=2)
