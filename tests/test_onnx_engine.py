"""Actual patched K/M/G + real I/NumPy. ORT/NLP and all data are synthetic.

No native inference, shipped profile, spaCy assets or pronunciation claim.
"""
import hashlib
from contextlib import ExitStack
import importlib
import importlib.util
import json
import string
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
import numpy as np
from tests.test_english_g2p import OffsetNLP, NUMBER_WORDS
from tests._private_vendor import require_private_vendor

MODULE = 'native.python.voice_runtime.onnx_engine'
G_MODULE = 'native.python.voice_runtime.english_g2p'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def canonical(vocab):
    return digest(json.dumps(sorted(vocab.items()), ensure_ascii=False, separators=(',', ':')).encode())

class SyntheticResources:
    def __init__(self, root):
        self._owned_handles = []
        self._cleanup = ExitStack()
        self.root = root/'vendor'
        self.model = root/'model.onnx'
        self.model.write_bytes(b'explicit synthetic model, NOT ONNX')
        self.voices = root/'voices.npz'
        np.savez(self.voices, af_heart=np.ones((510, 1, 4), dtype=np.float32))
        self.vocab = {c:i for i,c in enumerate('AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌθᵊᵻʔT ,.!?;:—“”()', 1)}
        self.vocab['~'] = 0
        self.gold = {w:'nk' for w in NUMBER_WORDS}
        self.gold.update({c:'bd' for c in string.ascii_uppercase})
        self.gold.update(hello='həlˈO', world='wɜɹld')
        self.put('resources/misaki/en/us_gold.json', json.dumps(self.gold).encode())
        self.put('resources/misaki/en/us_silver.json', b'{}')
        self.nlp_path = self.root/'resources/spacy/en_core_web_sm-3.8.0'
        for p in ['meta.json','config.cfg','tokenizer','tok2vec/model','tagger/model','vocab/strings.json']:
            self.put('resources/spacy/en_core_web_sm-3.8.0/'+p, b'{}')
        self.profile_path = self.root/'resources/kokoro/compatibility.json'
        self.configure('embedded')
        self.metadata = {'kokoro_config': json.dumps({'vocab': self.vocab})}
        self.session = Mock()
        self.session.get_providers.return_value = ['CPUExecutionProvider']
        self.session.get_modelmeta.side_effect = lambda: types.SimpleNamespace(custom_metadata_map=self.metadata)
        self.session.get_inputs.return_value = [types.SimpleNamespace(name=n,type=t) for n,t in [('tokens','tensor(int64)'),('style','tensor(float)'),('speed','tensor(float)')]]
        self.session.get_outputs.return_value = [types.SimpleNamespace(name='audio')]
        self.session.run.side_effect = lambda *_: [np.full(4096, 0.1, dtype=np.float32)]
        self.session_factory = Mock(return_value=self.session)
        self.nlp_loader = Mock(return_value=OffsetNLP())

    def close(self):
        try:
            self._cleanup.close()
        finally:
            self._owned_handles.clear()

    def put(self, name, data):
        path = self.root/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        return path

    def configure(self, mode):
        self.entry = dict(profileId='synthetic-v1',modelBytes=self.model.stat().st_size,
            modelSha256=digest(self.model.read_bytes()),vocabSource=mode,vocabCanonicalSha256=canonical(self.vocab))
        if mode == 'runtime-profile':
            raw=json.dumps(self.vocab).encode()
            rel='resources/kokoro/vocabularies/synthetic-v1.json'
            self.put(rel,raw)
            self.entry.update(relativePath=rel,vocabBytes=len(raw),vocabFileSha256=digest(raw))
        self.save_profile()

    def save_profile(self):
        self.put('resources/kokoro/compatibility.json', json.dumps(dict(schemaVersion=1,profiles=[self.entry])).encode())

    def boundaries(self):
        require_private_vendor()
        with ExitStack() as stack:
            ort=types.ModuleType('onnxruntime'); ort.InferenceSession=self.session_factory
            spacy=types.ModuleType('spacy'); spacy.load=self.nlp_loader
            stack.enter_context(patch.dict(sys.modules, {'onnxruntime':ort,'spacy':spacy}))
            stack.enter_context(patch(G_MODULE+'.resolve_resource_anchor', return_value=self.root))
            from voice_practice_speech_vendor.kokoro_onnx import Kokoro
            original=Kokoro._setup
            def owned_setup(instance, session, model_path, voices_path, tokenizer):
                try:
                    return original(instance,session,model_path,voices_path,tokenizer)
                finally:
                    # Capture this producer's lazy archive even if setup fails after load.
                    # Never scan GC or close another fixture's handles (including nested boundaries).
                    handle=getattr(instance,'voices',None)
                    if (Path(voices_path)==self.voices and handle is not None
                            and not any(handle is owned for owned in self._owned_handles)):
                        self._owned_handles.append(handle)
                        self._cleanup.callback(handle.close)
            stack.enter_context(patch.object(Kokoro,'_setup',owned_setup))
            return stack.pop_all()

class SyntheticResourceOwnershipTest(unittest.TestCase):
    def test_close_a_releases_own_archives_b_stays_live(self):
        from contextlib import closing
        from native.python.voice_runtime.onnx_engine import create_cpu_engine
        with tempfile.TemporaryDirectory() as ta, tempfile.TemporaryDirectory() as tb:
            with closing(SyntheticResources(Path(ta))) as a, closing(SyntheticResources(Path(tb))) as b:
                with a.boundaries():
                    ea=create_cpu_engine(a.model,a.voices)
                    ea2=create_cpu_engine(a.model,a.voices)
                with b.boundaries():
                    eb=create_cpu_engine(b.model,b.voices)
                with np.load(b.voices) as unrelated:
                    a.close()
                    self.assertIsNone(ea._kokoro.voices.zip)
                    self.assertIsNone(ea2._kokoro.voices.zip)
                    self.assertIsNotNone(eb._kokoro.voices.zip, 'close A closed live owner B')
                    np.testing.assert_array_equal(eb._kokoro.voices['af_heart'],unrelated['af_heart'])
                    a.close()  # own cleanup is idempotent
                b.close()
                self.assertIsNone(eb._kokoro.voices.zip)

    def test_failed_setup_releases_own_handle_before_temp_cleanup_not_b(self):
        from contextlib import closing
        from native.python.voice_runtime.onnx_engine import create_cpu_engine
        from native.python.voice_runtime.backends.base import BackendUnavailableError
        with tempfile.TemporaryDirectory() as ta, tempfile.TemporaryDirectory() as tb:
            with closing(SyntheticResources(Path(tb))) as b:
                with b.boundaries():
                    eb=create_cpu_engine(b.model,b.voices)
                opened=[]
                original=np.load
                def observe(*args,**kwargs):
                    handle=original(*args,**kwargs); opened.append(handle); return handle
                with self.assertRaisesRegex(RuntimeError,'failure after own NPZ load'):
                    with closing(SyntheticResources(Path(ta))) as a:
                        a.session.get_outputs.side_effect=RuntimeError('failure after own NPZ load')
                        with a.boundaries(),patch.object(np,'load',side_effect=observe):
                            create_cpu_engine(a.model,a.voices)
                self.assertEqual(len(opened),1)
                self.assertIsNone(opened[0].zip)
                self.assertIsNotNone(eb._kokoro.voices.zip, 'failed A cleanup closed live B')
                self.assertTrue(eb._kokoro.voices['af_heart'].size)
                # Still inside temp lifetime: handles are released before directory removal.
                self.assertTrue(Path(ta).exists())
                a.voices.unlink()


class OnnxEngineTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='onnx-v3b-')
        self.addCleanup(self.temp.cleanup)
        self.f=SyntheticResources(Path(self.temp.name))
        self.addCleanup(self.f.close)

    def module(self):
        self.assertIsNotNone(importlib.util.find_spec(MODULE), 'content-bound CPU factory missing')
        return importlib.import_module(MODULE)

    def test_actual_cpu_factory_same_session_real_k_m_g_numpy(self):
        module=self.module()
        with self.f.boundaries():
            engine=module.create_cpu_engine(self.f.model,self.f.voices)
            from voice_practice_speech_vendor.kokoro_onnx import Kokoro
            from voice_practice_speech_vendor.misaki.en import G2P
            self.assertIsInstance(engine._kokoro,Kokoro)
            self.assertIsInstance(engine._g._g2p,G2P)
            import os, zipfile
            build=Path(os.environ['SPEECH_VENDOR_BUILD'])
            receipt=json.loads((build/'build-result.json').read_text())
            wheel=build/receipt['wheel']
            self.assertEqual(digest(wheel.read_bytes()),'472a6fdfd3c3820add475fce3f547623098b0978f8e60bb8608ab16b3ec47e80')
            origins={}
            with zipfile.ZipFile(wheel) as archive:
                for name,loaded in list(sys.modules.items()):
                    if name.startswith('voice_practice_speech_vendor.') and getattr(loaded,'__file__',None):
                        origin=Path(loaded.__file__)
                        member=origin.relative_to(build/'source').as_posix()
                        self.assertEqual(origin.read_bytes(),archive.read(member))
                        origins[name]=digest(origin.read_bytes())
            self.assertIn('voice_practice_speech_vendor.kokoro_onnx',origins)
            self.assertIn('voice_practice_speech_vendor.misaki.en',origins)
            print('REAL_K_M_G_SOURCE '+json.dumps(dict(python=sys.version.split()[0],numpy=np.__version__,origins=origins)))
            self.assertIs(engine._kokoro.sess,self.f.session)
            self.f.session_factory.assert_called_once_with(str(self.f.model),providers=['CPUExecutionProvider'])
            self.f.nlp_loader.assert_called_once_with(self.f.nlp_path,enable=['tok2vec','tagger'])
            for text in ['hello world','-0.00','RTX4070']:
                samples,rate=engine.create(text,voice='af_heart',speed=1.0,lang='en-us')
                self.assertEqual(rate,24000)
                self.assertEqual(samples.ndim,1)
                self.assertTrue(samples.size and np.isfinite(samples).all())
            self.assertEqual(self.f.session.run.call_count,3)
            inputs=self.f.session.run.call_args.args[1]
            self.assertEqual(inputs['tokens'].dtype,np.int64)
            self.assertEqual(inputs['tokens'][0,0],0)
            self.assertTrue((inputs['tokens'][0,1:-1]>0).all())
            self.assertEqual(inputs['tokens'][0,-1],0)

    def test_profile_admission_rejects_before_session(self):
        from native.python.voice_runtime.backends.base import BackendUnavailableError
        module=self.module()
        good=dict(schemaVersion=1, profiles=[self.f.entry])
        cases=[{}, {**good,'schemaVersion':True}, {**good,'schemaVersion':2},
               {**good,'extra':1}, {**good,'profiles':[]},
               {**good,'profiles':[self.f.entry]*2},
               {**good,'profiles':[dict(self.f.entry, modelBytes=True)]},
               {**good,'profiles':[dict(self.f.entry, modelSha256='0'*64)]},
               {**good,'profiles':[dict(self.f.entry, profileId='../x')]},
               {**good,'profiles':[dict(self.f.entry, extra=1)]},
               {**good,'profiles':[dict(self.f.entry, vocabSource='fallback')]},
               {**good,'profiles':[dict(self.f.entry, relativePath='x')]},
               {**good,'profiles':[dict(self.f.entry, profileId='x'+str(i)) for i in range(33)]}]
        raw_cases=[json.dumps(x).encode() for x in cases]+[
            b'{"schemaVersion":1,"schemaVersion":1,"profiles":[]}',
            json.dumps(good).encode()+b' '*262144, b'{', b'{"schemaVersion":NaN,"profiles":[]}']
        with self.f.boundaries():
            for raw in raw_cases:
                with self.subTest(raw=raw[:100]):
                    self.f.profile_path.write_bytes(raw)
                    with self.assertRaises(BackendUnavailableError):
                        module.create_cpu_engine(self.f.model,self.f.voices)
                    self.f.session_factory.assert_not_called()
            self.f.profile_path.unlink()
            with self.assertRaises(BackendUnavailableError):
                module.create_cpu_engine(self.f.model,self.f.voices)
            self.f.session_factory.assert_not_called()

    def test_full_model_stream_and_rebind_before_run(self):
        import os
        from native.python.voice_runtime.backends.base import BackendUnavailableError
        module=self.module()
        self.f.model.write_bytes(b'A'*(2*1024*1024+7))
        self.f.configure('embedded')
        reads=[]
        model_reads=[]
        model_inode=self.f.model.stat().st_ino
        original=os.read
        def read(fd,size):
            reads.append(size)
            self.assertLessEqual(size,1024*1024)
            block=original(fd,size)
            if os.fstat(fd).st_ino==model_inode:
                model_reads.append(len(block))
            return block
        with self.f.boundaries(), patch('os.read',side_effect=read):
            module.create_cpu_engine(self.f.model,self.f.voices)
        self.assertTrue(reads, 'model must use bounded descriptor reads')
        self.assertEqual(sum(model_reads),2*self.f.model.stat().st_size)
        # New engine may not reuse filename/mtime identity from the first engine.
        self.f.session_factory.reset_mock()
        self.f.model.write_bytes(b'B'*(2*1024*1024+7))
        with self.f.boundaries(), self.assertRaises(BackendUnavailableError):
            module.create_cpu_engine(self.f.model,self.f.voices)
        self.f.session_factory.assert_not_called()
        self.f.session.run.assert_not_called()

    def test_explicit_vocab_modes_and_dual_agreement(self):
        from native.python.voice_runtime.backends.base import BackendUnavailableError
        module=self.module()
        for mode,metadata in [('embedded',True),('runtime-profile',False),('runtime-profile',True)]:
            with self.subTest(mode=mode,embedded=metadata), self.f.boundaries():
                self.f.configure(mode)
                self.f.metadata={'kokoro_config':json.dumps({'vocab':self.f.vocab})} if metadata else {}
                engine=module.create_cpu_engine(self.f.model,self.f.voices)
                self.assertEqual(dict(engine._g.vocab),self.f.vocab)
                samples,_=engine.create('hello',voice='af_heart',speed=1.0,lang='en-us')
                self.assertTrue(samples.size)
        for mode in ['embedded','runtime-profile']:
            self.f.configure(mode)
            for raw in ['{', '{"vocab":{}}', '{"vocab":{"h":true}}', '{"vocab":{"h":1,"h":2}}',json.dumps({'vocab':dict(self.f.vocab,h=987)})]:
                with self.subTest(mode=mode,raw=raw[:50]), self.f.boundaries():
                    self.f.metadata={'kokoro_config':raw}
                    self.f.session.run.reset_mock()
                    with self.assertRaises(BackendUnavailableError):
                        module.create_cpu_engine(self.f.model,self.f.voices)
                    self.f.session.run.assert_not_called()
        self.f.configure('embedded'); self.f.metadata={}
        with self.f.boundaries(), self.assertRaises(BackendUnavailableError):
            module.create_cpu_engine(self.f.model,self.f.voices)

    def test_runtime_vocab_file_proofs_before_session(self):
        from native.python.voice_runtime.backends.base import BackendUnavailableError
        module=self.module()
        self.f.configure('runtime-profile')
        path=self.f.root/self.f.entry['relativePath']
        raw=path.read_bytes()
        for data in [b'{}',raw+b' ',b'{"h":1,"h":2}',b'{"h":true}',b'{"h":1,"x":1}',b'{"xx":1}',b' '*262145,
                     json.dumps({chr(1000+i):i+1 for i in range(4097)}).encode()]:
            with self.subTest(size=len(data)), self.f.boundaries():
                path.write_bytes(data)
                # Except byte/hash tampering, bind the malformed bytes so strict map is load-bearing.
                if data not in (b'{}',raw+b' '):
                    self.f.entry.update(vocabBytes=len(data),vocabFileSha256=digest(data)); self.f.save_profile()
                self.f.session_factory.reset_mock()
                with self.assertRaises(BackendUnavailableError):
                    module.create_cpu_engine(self.f.model,self.f.voices)
                self.f.session_factory.assert_not_called()
        self.f.configure('runtime-profile')
        path.unlink()
        with self.f.boundaries(), self.assertRaises(BackendUnavailableError):
            module.create_cpu_engine(self.f.model,self.f.voices)

    def test_session_cpu_and_post_construction_model_identity(self):
        from native.python.voice_runtime.backends.base import BackendUnavailableError
        module=self.module()
        for providers in [[],['CUDAExecutionProvider'],['CPUExecutionProvider','CUDAExecutionProvider']]:
            with self.subTest(providers=providers), self.f.boundaries():
                self.f.session.get_providers.return_value=providers
                with self.assertRaises(BackendUnavailableError):
                    module.create_cpu_engine(self.f.model,self.f.voices)
                self.f.session.run.assert_not_called()
        self.f.session.get_providers.return_value=['CPUExecutionProvider']
        original=self.f.model.read_bytes()
        for replacement in [False,True]:
            self.f.model.write_bytes(original); self.f.configure('embedded')
            def construct(*args,**kwargs):
                if replacement:
                    other=self.f.model.with_suffix('.new'); other.write_bytes(original); other.replace(self.f.model)
                else:
                    self.f.model.write_bytes(b'changed after pre-hash')
                return self.f.session
            self.f.session_factory.side_effect=construct
            with self.subTest(replacement=replacement), self.f.boundaries(), self.assertRaises(BackendUnavailableError):
                module.create_cpu_engine(self.f.model,self.f.voices)
            self.f.session.run.assert_not_called()

    def test_actual_complete_create_lock_and_late_unknown_zero_inference(self):
        import threading
        from concurrent.futures import ThreadPoolExecutor
        from native.python.voice_runtime.backends.base import BackendInputError
        module=self.module()
        with self.f.boundaries():
            engine=module.create_cpu_engine(self.f.model,self.f.voices)
            with self.assertRaises(BackendInputError):
                engine.create('hello '*100+"qzx'foo",voice='af_heart',speed=1.0,lang='en-us')
            self.f.session.run.assert_not_called()
            entered,release,attempted=threading.Event(),threading.Event(),threading.Event()
            original_lock=engine._g.lock
            class ObservedLock:
                def __enter__(self):
                    if threading.current_thread().name.endswith('_1'):
                        attempted.set()
                    original_lock.acquire()
                def __exit__(self,*args): original_lock.release()
            engine._g.lock=ObservedLock()
            original=engine._kokoro.create_timed
            calls=[]
            def gated(*args,**kwargs):
                result=original(*args,**kwargs)
                calls.append(args[0])
                if len(calls)==1:
                    entered.set()
                    if not release.wait(3): raise AssertionError('release missing')
                return result
            with patch.object(engine._kokoro,'create_timed',side_effect=gated), ThreadPoolExecutor(max_workers=2,thread_name_prefix='complete') as pool:
                a=pool.submit(engine.create,'hello',voice='af_heart',speed=1.0,lang='en-us')
                try:
                    self.assertTrue(entered.wait(3))
                    b=pool.submit(engine.create,'RTX4070',voice='af_heart',speed=1.0,lang='en-us')
                    self.assertTrue(attempted.wait(3))
                    self.assertEqual(calls,['hello'])
                    self.assertEqual(self.f.session.run.call_count,1)
                finally: release.set()
                self.assertEqual(a.result(timeout=3)[1],24000)
                self.assertEqual(b.result(timeout=3)[1],24000)
            self.assertEqual(calls,['hello','RTX4070'])

    def test_model_voice_profile_and_vocab_symlinks_fail_before_session(self):
        from native.python.voice_runtime.backends.kokoro_onnx import KokoroOnnxBackend
        from native.python.voice_runtime.backends.base import BackendUnavailableError
        for target in ['model','voices','profile','vocab']:
            with self.subTest(target=target):
                self.f.configure('runtime-profile')
                path={'model':self.f.model,'voices':self.f.voices,'profile':self.f.profile_path,
                      'vocab':self.f.root/self.f.entry['relativePath']}[target]
                other=path.with_suffix(path.suffix+'.real'); path.rename(other)
                try:
                    try:
                        path.symlink_to(other)
                    except OSError as e:
                        if getattr(e, 'winerror', None) == 1314 or getattr(e, 'errno', 0) in (1, 13):
                            self.skipTest('creating file symlink requires elevated privilege or Developer Mode on Windows')
                        raise
                    self.f.session_factory.reset_mock()
                    with self.f.boundaries(),self.assertRaises(BackendUnavailableError):
                        backend=KokoroOnnxBackend(model_path=self.f.model,voices_path=self.f.voices)
                        backend.synthesize('hello','af_heart',1.0)
                    self.f.session_factory.assert_not_called()
                finally:
                    if path.is_symlink() or path.exists():
                        path.unlink()
                    if other.exists():
                        other.rename(path)

    def test_actual_k_setup_wrong_session_identity_rejected(self):
        from native.python.voice_runtime.backends.base import BackendUnavailableError
        module=self.module()
        with self.f.boundaries():
            from voice_practice_speech_vendor.kokoro_onnx import Kokoro
            original=Kokoro._setup
            def wrong(instance,*args,**kwargs):
                original(instance,*args,**kwargs)
                instance.sess=object()
            with patch.object(Kokoro,'_setup',wrong),self.assertRaises(BackendUnavailableError):
                module.create_cpu_engine(self.f.model,self.f.voices)
            self.f.session.run.assert_not_called()

    def test_descriptor_bytes_binary_flag_and_observed_mutation(self):
        import os
        from native.python.voice_runtime.backends.base import BackendUnavailableError
        module=self.module()
        original_open=os.open
        flag=1 << 28
        observed=[]
        def binary_open(path,flags,*args,**kwargs):
            observed.append(bool(flags & flag))
            return original_open(path,flags & ~flag,*args,**kwargs)
        with self.f.boundaries(),patch.object(os,'O_BINARY',flag,create=True),patch('os.open',side_effect=binary_open):
            module.create_cpu_engine(self.f.model,self.f.voices)
        self.assertTrue(observed and all(observed), 'all descriptor reads must preserve binary bytes on Windows')
        self.f.session_factory.reset_mock()
        original_read=os.read
        inode=self.f.model.stat().st_ino
        changed=[]
        def read(fd,size):
            block=original_read(fd,size)
            if os.fstat(fd).st_ino==inode and not changed:
                changed.append(True)
                with self.f.model.open('ab') as handle: handle.write(b'growth')
            return block
        with self.f.boundaries(),patch('os.read',side_effect=read),self.assertRaises(BackendUnavailableError):
            module.create_cpu_engine(self.f.model,self.f.voices)
        self.assertEqual(changed,[True])
        self.f.session_factory.assert_not_called()

    def test_resource_bounds_paths_and_actual_missing_g_coverage(self):
        from native.python.voice_runtime.backends.base import BackendUnavailableError
        from native.python.voice_runtime.backends.kokoro_onnx import KokoroOnnxBackend
        module=self.module()
        # Oversized valid document with whitespace: prove rejection before JSON parse.
        self.f.profile_path.write_bytes(self.f.profile_path.read_bytes()+b' '*262144)
        with self.f.boundaries(),patch.object(module,'_json',wraps=module._json) as parse:
            with self.assertRaises(BackendUnavailableError):
                module.create_cpu_engine(self.f.model,self.f.voices)
            parse.assert_not_called(); self.f.session_factory.assert_not_called()
        self.f.configure('runtime-profile')
        self.f.entry['relativePath']='../outside.json'; self.f.save_profile()
        with self.f.boundaries(),self.assertRaises(BackendUnavailableError):
            module.create_cpu_engine(self.f.model,self.f.voices)
        self.f.session_factory.assert_not_called()
        self.f.configure('runtime-profile')
        self.f.entry['vocabCanonicalSha256']='0'*64; self.f.save_profile()
        with self.f.boundaries(),self.assertRaises(BackendUnavailableError):
            module.create_cpu_engine(self.f.model,self.f.voices)
        self.f.session_factory.assert_not_called()
        self.f.configure('embedded')
        for word in ['A','zero']:
            bad=dict(self.f.gold); del bad[word]
            self.f.put('resources/misaki/en/us_gold.json',json.dumps(bad).encode())
            with self.subTest(missing=word),self.f.boundaries():
                backend=KokoroOnnxBackend(model_path=self.f.model,voices_path=self.f.voices)
                with self.assertRaises(BackendUnavailableError): backend.synthesize('hello','af_heart',1.0)
                self.assertFalse(backend.provider_evidence()['inferenceSucceeded'])
                self.f.session.run.assert_not_called()
        self.f.put('resources/misaki/en/us_gold.json',json.dumps(self.f.gold).encode())
        # Nonempty silence stays valid, including actual K trimming and WAV.
        self.f.session.run.side_effect=lambda *_:[np.zeros(4096,dtype=np.float32)]
        with self.f.boundaries():
            backend=KokoroOnnxBackend(model_path=self.f.model,voices_path=self.f.voices)
            self.assertEqual(backend.synthesize('hello','af_heart',1.0)['sampleRate'],24000)
            self.assertTrue(backend.provider_evidence()['inferenceSucceeded'])

if __name__=='__main__':
    unittest.main()
