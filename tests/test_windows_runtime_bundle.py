"""S4 source-only tests: real tiny files/ZIPs; no native or model execution."""
import hashlib
import importlib.util
import json
import ntpath
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SPIKE = ROOT / 'spikes/packaged-runtime'

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SPIKE / filename)
    module = importlib.util.module_from_spec(spec)
    with patch.object(sys, 'path', [str(SPIKE), *sys.path]):
        spec.loader.exec_module(module)
    return module

class BuildAdmissionTests(unittest.TestCase):
    def test_actual_windows_plan_refuses_missing_full_bundle_before_subprocess(self):
        driver = load('s4_driver', 'build-runtime.py')
        with patch.object(driver, 'platform_key', return_value='win32-x64-cpu'), \
                patch.object(sys, 'argv', ['build-runtime.py', '--dry-run']), \
                patch.object(driver.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'bundle'):
                driver.main()
            run.assert_not_called()

VENDOR = 'voice_practice_speech_vendor'
SPACY = VENDOR + '/resources/spacy/en_core_web_sm-3.8.0/'

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def identity(path, relative):
    raw = path.read_bytes()
    return {'path': relative, 'bytes': len(raw), 'sha256': digest(raw)}

def fixture(root) -> tuple[tuple[Path, str], dict[str, Any]]:
    """Synthetic assets, actual immutable code wheel. NOT model compatibility proof."""
    import shutil
    import zipfile
    if 'SPEECH_VENDOR_BUILD' not in os.environ:
        raise unittest.SkipTest('set SPEECH_VENDOR_BUILD to the fixed offline code-only artifact')
    code = Path(os.environ['SPEECH_VENDOR_BUILD']) / 'voice_practice_speech_vendor-0.1.0+kmf.v1-py3-none-any.whl'
    shutil.copyfile(code, root / code.name)
    vocab = {'a': 1, ' ': 2}
    vocab_raw = json.dumps(vocab).encode()
    profile = dict(profileId='synthetic', modelBytes=1, modelSha256=digest(b'x'),
                   vocabSource='runtime-profile', relativePath='resources/kokoro/vocabularies/synthetic.json',
                   vocabBytes=len(vocab_raw), vocabFileSha256=digest(vocab_raw),
                   vocabCanonicalSha256=digest(json.dumps(sorted(vocab.items()), ensure_ascii=False, separators=(',', ':')).encode()))
    files = {
        VENDOR + '/resources/misaki/en/us_gold.json': b'{"a":"a"}',
        VENDOR + '/resources/misaki/en/us_silver.json': b'{"test":"a"}',
        VENDOR + '/resources/kokoro/compatibility.json': json.dumps({'schemaVersion':1, 'profiles':[profile]}).encode(),
        VENDOR + '/resources/kokoro/vocabularies/synthetic.json': vocab_raw,
        VENDOR + '/faster_whisper/assets/silero_vad_v6.onnx': b'synthetic-not-an-onnx-model',
    }
    spacy_files = {'meta.json': b'{"lang":"en","name":"core_web_sm","version":"3.8.0","pipeline":["tok2vec","tagger","parser","attribute_ruler","lemmatizer","ner"]}',
                   'config.cfg': b'[nlp]\nlang = "en"\n', 'tokenizer':b'x',
                   'tok2vec/model':b'x', 'tagger/model':b'x', 'parser/model':b'x',
                   'ner/model':b'x', 'vocab/strings.json':b'[]', 'vocab/vectors':b'x',
                   'vocab/key2row':b'x', 'vocab/lookups.bin':b'x', 'vocab/vectors.cfg':b'{}',
                   'attribute_ruler/patterns':b'[]', 'lemmatizer/lookups/lookups.bin':b'x',
                   'LICENSE':b'SYNTHETIC license', 'LICENSES_SOURCES':b'SYNTHETIC sources'}
    files.update({SPACY+p:b for p,b in spacy_files.items()})
    with zipfile.ZipFile(root/'spacy.zip', 'w') as archive:
        for p,b in spacy_files.items(): archive.writestr('en_core_web_sm-3.8.0/'+p,b)
    inventory = []
    for p,b in files.items():
        path = root/'payload'/p; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(b)
        inventory.append(identity(path,p))
    reviews = {}
    for subject in ('vendor-code','misaki','spacy','kokoro','vad','third-party'):
        p = 'reviews/'+subject+'.txt'; path = root/p; path.parent.mkdir(exist_ok=True)
        path.write_text('SYNTHETIC test evidence only; no legal/native approval')
        reviews[subject] = identity(path,p)
    doc = dict(schemaVersion=1, codeWheel=identity(root/code.name,code.name), resourceRoot='payload',
               files=inventory, spacySource={**identity(root/'spacy.zip','spacy.zip'), 'prefix':'en_core_web_sm-3.8.0'}, reviews=reviews)
    return save_bundle(root,doc), doc

def save_bundle(root,doc):
    raw = json.dumps(doc,sort_keys=True).encode(); (root/'bundle.json').write_bytes(raw)
    return root/'bundle.json', digest(raw)

class ResourceAdmissionTests(unittest.TestCase):
    def test_real_code_wheel_plus_complete_tiny_inventory_is_admitted_not_code_only(self):
        self.assertTrue((SPIKE/'windows_bundle.py').exists(), 'missing executable resource admission')
        bundle = load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (path, sha), doc=fixture(root)
            admitted=bundle.admit_resources(path,sha)
            self.assertEqual(len(admitted['files']),len(doc['files']))
            self.assertEqual(admitted['codeSha256'],'472a6fdfd3c3820add475fce3f547623098b0978f8e60bb8608ab16b3ec47e80')
            doc['files']=[]; path,sha=save_bundle(root,doc)
            with self.assertRaisesRegex(ValueError,'resource'):
                bundle.admit_resources(path,sha)

class PreparationTests(unittest.TestCase):
    def test_actual_prepare_caller_produces_distinct_complete_record_bound_wheel(self):
        self.assertTrue(hasattr(load('s4_bundle','windows_bundle.py'),'prepare'), 'missing complete build preparation')
        import zipfile
        driver=load('s4_driver','build-runtime.py')
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); inputs=root/'inputs'; inputs.mkdir()
            (path,sha),doc=fixture(inputs)
            house,lock=public_fixture(root)
            out=root/'prepared'
            with patch.object(driver,'WINDOWS_LOCK',lock):
                rc=driver.main(['--prepare-only','--bundle',str(path),'--bundle-sha256',sha,
                                '--wheelhouse',str(house),'--output',str(out)])
            self.assertEqual(rc,0)
            report=json.loads((out/'preparation.json').read_text())
            wheel=out/report['vendorWheel']
            self.assertNotEqual(digest(wheel.read_bytes()),doc['codeWheel']['sha256'])
            members=bundle.wheel_inventory(wheel)['files']
            self.assertTrue(set(doc_entry['path'] for doc_entry in doc['files'])<=set(members))
            with zipfile.ZipFile(wheel) as archive:
                self.assertIn(b'CODE_ONLY = True',archive.read(VENDOR+'/__init__.py'))
                self.assertIn('bundleSha256',json.loads(archive.read(VENDOR+'/s4-build-provenance.json')))
                self.assertIn(VENDOR+'/notices/s4/spacy.txt',archive.namelist())
            self.assertIn('--hash=sha256:'+digest(wheel.read_bytes()),(out/'install.lock.txt').read_text())
            other=root/'prepared-other'
            bundle.prepare(path,sha,house,other,lock)
            self.assertEqual(wheel.read_bytes(),(other/report['vendorWheel']).read_bytes())
            with self.assertRaises((ValueError,FileExistsError)):
                bundle.prepare(path,sha,house,out,lock)


def public_fixture(root):
    import base64,csv,io,zipfile
    house=root/'wheelhouse'; house.mkdir()
    metadata='sample-1.0.dist-info/'
    files={'sample/__init__.py':b'# inert fixture',metadata+'METADATA':b'Metadata-Version: 2.1\nName: sample\nVersion: 1.0\n',
           metadata+'WHEEL':b'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n'}
    rows=[]
    for p,b in files.items(): rows.append((p,'sha256='+base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b'=').decode(),str(len(b))))
    rec=metadata+'RECORD'; rows.append((rec,'','')); stream=io.StringIO(); csv.writer(stream,lineterminator='\n').writerows(rows); files[rec]=stream.getvalue().encode()
    wheel=house/'sample-1.0-py3-none-any.whl'
    with zipfile.ZipFile(wheel,'w') as archive:
        for p,b in files.items(): archive.writestr(p,b)
    lock=root/'public.lock'; lock.write_text('sample==1.0 --hash=sha256:'+digest(wheel.read_bytes())+'\n')
    return house,lock

class DriverSpecTests(unittest.TestCase):
    def test_build_spec_and_post_build_are_on_actual_driver_path(self):
        driver=load('s4_driver','build-runtime.py'); bundle=driver.windows_bundle
        self.assertTrue(hasattr(bundle,'verify_prepared'), 'missing admitted build/spec path')
        import shutil
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); inputs=root/'inputs'; inputs.mkdir()
            (path,sha),doc=fixture(inputs); house,lock=public_fixture(root)
            prepared=root/'prepared'; bundle.prepare(path,sha,house,prepared,lock)
            out=root/'build'; captured={}
            toc_mode='windows'
            normal=root/'normal.dll'; normal.write_bytes(b'SYNTHETIC inert binary')
            binary_rows=[('normal.dll',str(normal),'BINARY'),
                         ('sample/_core.pyd',str(normal),'EXTENSION')]
            denied_names={'forbidden-binary':'libespeak-ng.dll',
                          'forbidden-cudnn':'ctranslate2/cudnn64_9.dll',
                          'forbidden-variant':r'SAMPLE.LIBS\CuDaRt64_12.DLL'}
            inflect_source=root/'inflect/__init__.py'
            inflect_source.parent.mkdir(); inflect_source.write_bytes(b'# inert source fixture')
            inflect_data=(str(inflect_source),'inflect')
            inflect_row=(ntpath.join('inflect','__init__.py'),str(inflect_source),'DATA')
            original_validate=bundle.validate_collection
            def validate(analysis,plan):
                captured['events'].append('validate')
                captured['validated_binaries']=list(analysis.binaries)
                captured['validated_rows']={name:list(getattr(analysis,name))
                                            for name in ('pure','binaries','datas')}
                try:
                    return original_validate(analysis,plan)
                finally:
                    # Even a refusing validator must receive the intact Analysis.
                    captured['after_validation_rows']={name:list(getattr(analysis,name))
                                                       for name in ('pure','binaries','datas')}
            changed=root/'changed-data'; changed.write_bytes(b'changed collection bytes')
            args=['--bundle',str(path),'--bundle-sha256',sha,'--wheelhouse',str(house),
                  '--prepared',str(prepared),'--output',str(out)]
            def pyinstaller(command,**kwargs):
                self.assertNotIn('--noconfirm',command)
                self.assertIn('--distpath',command); self.assertIn('--workpath',command)
                self.assertTrue(kwargs['check'])
                captured['events']=[]
                hook_calls=[]
                def analysis(scripts,**options):
                    self.assertEqual(hook_calls,[('inflect',True)])
                    self.assertEqual(options['datas'].count(inflect_data),1)
                    captured['events'].append('Analysis')
                    captured.update(options); captured['scripts']=scripts
                    # Windows TOC-name double; source paths/bytes remain real host files.
                    rows=[(ntpath.join(dest,Path(src).name),src,'DATA') for src,dest in options['datas']]
                    rows=[(ntpath.normpath(name),src,kind) for name,src,kind in rows]
                    if toc_mode=='missing': rows=rows[1:]
                    elif toc_mode=='missing-inflect': rows=[row for row in rows if row!=inflect_row]
                    elif toc_mode=='changed': rows[0]=(rows[0][0],str(changed),'DATA')
                    elif toc_mode=='missing-file': rows[0]=(rows[0][0],str(root/'absent'),'DATA')
                    elif toc_mode=='remapped': rows[0]=('remapped\\file.txt',rows[0][1],'DATA')
                    elif toc_mode=='collision': rows.append((rows[0][0].replace('\\','/'),rows[0][1],'DATA'))
                    elif toc_mode=='traversal': rows.append(('..\\escape',rows[0][1],'DATA'))
                    binaries=[*binary_rows]; pure=[]
                    if toc_mode in denied_names:
                        binaries.append((denied_names[toc_mode],str(normal),'BINARY'))
                    elif toc_mode=='forbidden-pure': pure.append(('torch',str(normal),'PYMODULE'))
                    elif toc_mode=='forbidden-data': rows.append(('libespeak-ng.dll',str(normal),'DATA'))
                    captured['analysis_binaries']=list(binaries)
                    captured['analysis_rows']={'pure':list(pure),'binaries':list(binaries),'datas':list(rows)}
                    return SimpleNamespace(pure=pure,scripts=[],binaries=binaries,datas=rows)
                def pyz(*a): captured['events'].append('PYZ'); return object()
                def exe(*a,**kw):
                    captured['events'].append('EXE'); captured['exe']=kw; return object()
                def collect(*a,**kw):
                    captured['events'].append('COLLECT')
                    captured['collected_binaries']=list(a[1])
                    self.assertEqual(a[1],captured['analysis_rows']['binaries'])
                    self.assertEqual(a[2],captured['analysis_rows']['datas'])
                    self.assertEqual(a[2].count(inflect_row),1)
                    runtime=Path(command[command.index('--distpath')+1])/'voice-runtime'
                    runtime.mkdir(parents=True)
                    (runtime/'voice-runtime.exe').write_bytes(b'SYNTHETIC PyInstaller boundary')
                    for name,src,kind in a[2]:
                        self.assertEqual(kind,'DATA')
                        dst=runtime/'_internal'/name.replace('\\','/'); dst.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(src,dst)
                    for src in (prepared/'source'/VENDOR).rglob('*.py'):
                        dst=runtime/'_internal'/src.relative_to(prepared/'source').with_suffix('.pyc')
                        dst.parent.mkdir(parents=True,exist_ok=True); dst.write_bytes(b'SYNTHETIC compiled boundary')
                    return object()
                # Only first-party driver/spec/validator execute. PyInstaller and
                # installed inflect collection are explicit inert import doubles.
                import argparse, builtins, pathlib
                def collect_data_files(package, *, include_py_files=False):
                    self.assertEqual((package,include_py_files),('inflect',True))
                    self.assertTrue(inflect_source.is_file())
                    hook_calls.append((package,include_py_files))
                    return [inflect_data]
                imports={'pathlib':pathlib,'platform':SimpleNamespace(system=lambda:'Windows'),
                         'sys':SimpleNamespace(path=[]),'argparse':argparse,'windows_bundle':bundle,
                         'PyInstaller.utils.hooks':SimpleNamespace(collect_data_files=collect_data_files)}
                def restricted_import(name, globals=None, locals=None, fromlist=(), level=0):
                    if level or name not in imports:
                        raise AssertionError('Unexpected spec import: '+name)
                    if name=='PyInstaller.utils.hooks':
                        self.assertEqual(fromlist,('collect_data_files',))
                    return imports[name]
                namespace=dict(SPECPATH=str(SPIKE),Analysis=analysis,PYZ=pyz,EXE=exe,COLLECT=collect,
                               __builtins__=dict(vars(builtins),__import__=restricted_import))
                specargs=command[command.index('--')+1:]
                with (patch.object(sys,'argv',['voice-runtime.spec',*specargs]),
                      patch.object(bundle,'validate_collection',side_effect=validate)):
                    exec(compile((SPIKE/'voice-runtime.spec').read_text(),str(SPIKE/'voice-runtime.spec'),'exec'),namespace)
                self.assertEqual(hook_calls,[('inflect',True)])
                return SimpleNamespace(returncode=0)
            with patch.object(driver,'WINDOWS_LOCK',lock),patch.object(bundle,'DEFAULT_LOCK',lock), \
                    patch.object(driver,'platform_key',return_value='win32-x64-cpu'), \
                    patch.object(bundle,'require_native'),patch.object(bundle,'verify_installed',return_value={}), \
                    patch.object(driver.subprocess,'run',side_effect=pyinstaller) as run:
                self.assertEqual(driver.main(args),0)
                self.assertEqual(run.call_count,1)
            self.assertEqual(captured['events'],['Analysis','validate','PYZ','EXE','COLLECT'])
            self.assertEqual(captured['analysis_rows'],captured['validated_rows'])
            self.assertEqual(captured['analysis_rows'],captured['after_validation_rows'])
            self.assertIn((r'inflect\__init__.py',str(inflect_source),'DATA'),captured['validated_rows']['datas'])
            self.assertEqual(captured['analysis_binaries'],binary_rows)
            self.assertEqual(captured['validated_binaries'],binary_rows)
            self.assertEqual(captured['collected_binaries'],binary_rows)
            self.assertTrue(captured['noarchive'])
            self.assertEqual(captured['exe']['contents_directory'],'_internal')
            self.assertIn('onnxruntime',captured['hiddenimports'])
            self.assertIn(VENDOR+'.kokoro_onnx',captured['hiddenimports'])
            self.assertIn('misaki',captured['excludes'])
            self.assertEqual(captured['scripts'],[str(ROOT/'native/python/voice_runtime/server.py')])
            self.assertTrue((out/'post-build.json').exists())
            self.assertEqual((out/'dist/voice-runtime/_internal/inflect/__init__.py').read_bytes(),inflect_source.read_bytes())
            report=json.loads((out/'post-build.json').read_text())
            self.assertEqual(report['files']['_internal/inflect/__init__.py']['sha256'],digest(inflect_source.read_bytes()))
            # Binary regressions target the removed filter. Other lanes preserve
            # existing resource/pure/data gates; they need not fail on old source.
            for toc_mode in (*denied_names,'forbidden-pure','forbidden-data',
                             'missing','missing-inflect','missing-file','changed','remapped','collision','traversal'):
                rejected=root/('rejected-'+toc_mode)
                with self.subTest(toc_mode=toc_mode), \
                        patch.object(driver,'WINDOWS_LOCK',lock),patch.object(bundle,'DEFAULT_LOCK',lock), \
                        patch.object(driver,'platform_key',return_value='win32-x64-cpu'), \
                        patch.object(bundle,'require_native'),patch.object(bundle,'verify_installed',return_value={}), \
                        patch.object(driver.subprocess,'run',side_effect=pyinstaller):
                    captured.pop('exe')
                    refusal=(self.assertRaises(FileNotFoundError) if toc_mode=='missing-file' else
                             self.assertRaisesRegex(ValueError,'forbidden collected' if
                                 toc_mode.startswith('forbidden-') else 'collected resource|path'))
                    with refusal:
                        driver.main([*args[:-1],str(rejected)])
                    self.assertEqual(captured['events'],['Analysis','validate'])
                    self.assertEqual(captured['validated_binaries'],captured['analysis_binaries'])
                    self.assertEqual(captured['analysis_rows'],captured['validated_rows'])
                    self.assertEqual(captured['analysis_rows'],captured['after_validation_rows'])
                    if toc_mode in denied_names:
                        self.assertEqual(captured['validated_binaries'],
                                         [*binary_rows,(denied_names[toc_mode],str(normal),'BINARY')])
                    self.assertNotIn('exe',captured)
                    self.assertFalse((rejected/'post-build.json').exists())
                    self.assertFalse((rejected/'dist').exists())
                    captured['exe']={}
            plan=bundle.verify_prepared(path,sha,house,prepared,lock)
            runtime=out/'dist/voice-runtime'
            victim=runtime/'_internal'/doc['files'][0]['path']; original=victim.read_bytes(); victim.write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError,'resource|content'):
                bundle.post_build(runtime,plan)
            victim.write_bytes(original)
            forbidden=runtime/'_internal/libespeak-ng.dll'; forbidden.write_bytes(b'SYNTHETIC forbidden binary')
            with self.assertRaisesRegex(ValueError,'forbidden post-build'):
                bundle.post_build(runtime,plan)
            forbidden.unlink()
            misplaced=runtime/'misplaced.txt'; misplaced.write_text('wrong layout')
            with self.assertRaisesRegex(ValueError,'wrong onedir'):
                bundle.post_build(runtime,plan)
            misplaced.unlink(); (runtime/'voice-runtime.exe').unlink()
            with self.assertRaisesRegex(ValueError,'missing onedir entrypoint'):
                bundle.post_build(runtime,plan)

class CollectionSeparatorTests(unittest.TestCase):
    def setUp(self):
        from types import SimpleNamespace
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name); inputs=self.root/'inputs'; inputs.mkdir()
        (self.path,self.sha),self.doc=fixture(inputs)
        self.bundle=load('s4_separator_bundle','windows_bundle.py')
        house,lock=public_fixture(self.root); prepared=self.root/'prepared'
        self.bundle.prepare(self.path,self.sha,house,prepared,lock)
        self.plan=self.bundle.verify_prepared(self.path,self.sha,house,prepared,lock)
        self.rows=[(dest+'/'+Path(src).name,src,'DATA') for src,dest in self.plan['datas']]
        self.analysis=SimpleNamespace(pure=[],binaries=[],datas=self.rows)

    def test_identical_admitted_bytes_accept_windows_and_mixed_separators(self):
        before={src:digest(Path(src).read_bytes()) for _,src,_ in self.rows}
        self.assertEqual(len(self.rows),40)
        for style in ('slash','windows','mixed'):
            with self.subTest(style=style):
                self.analysis.datas=[(name if style=='slash' else
                    ntpath.normpath(name) if style=='windows' else name.replace('/','\\',1),src,kind)
                    for name,src,kind in self.rows]
                self.assertIsNone(self.bundle.validate_collection(self.analysis,self.plan))
        self.assertEqual(before,{src:digest(Path(src).read_bytes()) for _,src,_ in self.rows})

    def test_canonical_separator_and_case_collisions_are_rejected(self):
        name,src,kind=self.rows[0]
        for alias in (name,ntpath.normpath(name),name.replace('/','\\',1),ntpath.normpath(name.upper())):
            with self.subTest(alias=alias):
                self.analysis.datas=[*self.rows,(alias,src,kind)]
                with self.assertRaisesRegex(ValueError,'duplicate collected resource'):
                    self.bundle.validate_collection(self.analysis,self.plan)

    def test_unsafe_destinations_are_rejected_even_beside_complete_inventory(self):
        for name in ('/escape','\\escape','C:/escape','C:\\escape','C:escape',
                     '\\\\server\\share\\file','\\\\?\\C:\\escape','../escape','..\\escape',
                     'ok/..\\escape','ok\\..\\escape','ok\\.\\file','ok\\\\file',
                     'ok/CON.txt','ok\\file:stream','ok\\file.','ok\\file '):
            with self.subTest(name=name):
                self.analysis.datas=[*self.rows,(name,self.rows[0][1],'DATA')]
                with self.assertRaisesRegex(ValueError,'path'):
                    self.bundle.validate_collection(self.analysis,self.plan)

    def test_windows_collection_preserves_missing_changed_and_remap_refusals(self):
        rows=[(ntpath.normpath(name),src,kind) for name,src,kind in self.rows]
        changed=self.root/'changed'; changed.write_bytes(b'changed bytes')
        for mode in ('missing-entry','missing-file','changed','remapped'):
            with self.subTest(mode=mode):
                self.analysis.datas=list(rows)
                if mode=='missing-entry': self.analysis.datas=rows[1:]
                elif mode=='missing-file': self.analysis.datas[0]=(rows[0][0],str(self.root/'absent'),'DATA')
                elif mode=='changed': self.analysis.datas[0]=(rows[0][0],str(changed),'DATA')
                else: self.analysis.datas[0]=('remapped\\file.txt',rows[0][1],'DATA')
                with self.assertRaises((ValueError,FileNotFoundError)):
                    self.bundle.validate_collection(self.analysis,self.plan)

    def test_resource_inventory_and_zip_still_require_slash_paths(self):
        import zipfile
        self.doc['files'][0]['path']=ntpath.normpath(self.doc['files'][0]['path'])
        path,sha=save_bundle(self.path.parent,self.doc)
        with self.assertRaisesRegex(ValueError,'path'):
            self.bundle.admit_resources(path,sha)
        archive=self.root/'backslash.zip'
        with zipfile.ZipFile(archive,'w') as target:
            target.writestr('safe.txt',b'inert fixture')
        orig_infolist = zipfile.ZipFile.infolist
        def mock_infolist(z_self):
            infos = orig_infolist(z_self)
            if z_self.filename == str(archive):
                infos[0].filename = 'safe\\file.txt'
            return infos
        with patch.object(zipfile.ZipFile, 'infolist', mock_infolist):
            with self.assertRaisesRegex(ValueError,'path'):
                self.bundle.zip_inventory(archive)


class ForbiddenPathTargetScopeTests(unittest.TestCase):
    """The leaf-segment exemption is Windows-target only; the shared default stays strict."""
    def test_accelerator_leaf_is_strict_by_default_and_relaxed_only_for_windows_target(self):
        bundle=load('s4_bundle_scope','windows_bundle.py')
        for leaf in ('pkg/nvidia_cuda.py','pkg/onnxruntime_gpu.py','pkg/onnxruntime-directml.txt'):
            with self.subTest(leaf=leaf):
                self.assertTrue(bundle.forbidden_path(leaf))
                self.assertFalse(bundle.forbidden_path(leaf, windows_target=True))
        # Directory segments and native leaves stay forbidden for both targets.
        for path in ('nvidia-cudnn/x.py','onnxruntime_gpu/capi/x.py','pkg/cudnn64_9.dll','pkg/libespeak-ng.dll'):
            with self.subTest(path=path):
                self.assertTrue(bundle.forbidden_path(path))
                self.assertTrue(bundle.forbidden_path(path, windows_target=True))


class BoundaryFixTests(unittest.TestCase):
    def test_fully_inventoried_executable_resource_is_not_data(self):
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (path,sha),doc=fixture(root)
            rel=VENDOR+'/resources/kokoro/injected.py'
            target=root/'payload'/rel; target.write_bytes(b'raise RuntimeError("never execute")')
            doc['files'].append(identity(target,rel)); path,sha=save_bundle(root,doc)
            with self.assertRaisesRegex(ValueError,'resource destination|executable'):
                bundle.admit_resources(path,sha)

    def test_universal_py2_py3_official_tag_form_is_compatible(self):
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); house,lock=public_fixture(root)
            wheel=next(house.iterdir())
            rewrite_wheel(wheel, {'sample-1.0.dist-info/WHEEL':b'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py2-none-any\nTag: py3-none-any\n'})
            target=house/'sample-1.0-py2.py3-none-any.whl'; wheel.rename(target)
            self.assertEqual(bundle.wheel_inventory(target)['name'],'sample')

    def test_zip_central_directory_bound_is_checked_before_zipfile_allocates(self):
        import struct
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            archive=Path(tmp)/'huge.zip'
            archive.write_bytes(struct.pack('<4s4H2IH',b'PK\x05\x06',0,0,1,1,9*1024*1024,0,0))
            with patch.object(bundle.zipfile,'ZipFile',side_effect=AssertionError('unbounded central directory read')):
                with self.assertRaisesRegex(ValueError,'central'):
                    bundle.zip_inventory(archive)


def rewrite_wheel(path, updates):
    """Real ZIP rewrite with correct RECORD, for finite adversarial fixtures only."""
    import zipfile,base64,csv,io
    with zipfile.ZipFile(path) as archive: files={p:archive.read(p) for p in archive.namelist()}
    files.update(updates)
    record=next(p for p in files if p.endswith('.dist-info/RECORD'))
    rows=[]
    for p,b in sorted(files.items()):
        if p!=record: rows.append((p,'sha256='+base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b'=').decode(),str(len(b))))
    rows.append((record,'','')); stream=io.StringIO(); csv.writer(stream,lineterminator='\n').writerows(rows); files[record]=stream.getvalue().encode()
    with zipfile.ZipFile(path,'w') as archive:
        for p,b in files.items(): archive.writestr(p,b)

class FiniteAdmissionMatrixTests(unittest.TestCase):
    def test_resource_identity_missing_extra_and_original_spacy_completeness(self):
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (path,sha),doc=fixture(root)
            bundle.admit_resources(path,sha)
            with self.assertRaisesRegex(ValueError,'bundle hash'):
                bundle.admit_resources(path,'0'*64)
            extra=root/'payload'/SPACY/'unexpected'; extra.write_bytes(b'x')
            with self.assertRaisesRegex(ValueError,'resource inventory'):
                bundle.admit_resources(path,sha)
            extra.unlink()
            rel=SPACY+'parser/model'; (root/'payload'/rel).unlink()
            doc['files']=[item for item in doc['files'] if item['path']!=rel]
            path,sha=save_bundle(root,doc)
            with self.assertRaisesRegex(ValueError,'incomplete original spaCy'):
                bundle.admit_resources(path,sha)

    def test_profile_conflict_review_tamper_and_duplicate_json_are_reachable(self):
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (path,sha),doc=fixture(root)
            bundle.admit_resources(path,sha)
            review=root/doc['reviews']['kokoro']['path']; original=review.read_bytes()
            review.write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError,'file hash/size'):
                bundle.admit_resources(path,sha)
            review.write_bytes(original)
            rel=VENDOR+'/resources/kokoro/compatibility.json'; profile=root/'payload'/rel
            data=json.loads(profile.read_text()); data['profiles'].append({**data['profiles'][0],'profileId':'conflict'})
            profile.write_text(json.dumps(data))
            doc['files']=[identity(profile,rel) if item['path']==rel else item for item in doc['files']]
            path,sha=save_bundle(root,doc)
            with self.assertRaisesRegex(ValueError,'duplicate profile'):
                bundle.admit_resources(path,sha)
            raw=b'{"schemaVersion":1,"schemaVersion":1}'; path.write_bytes(raw)
            with self.assertRaisesRegex(ValueError,'invalid JSON'):
                bundle.admit_resources(path,digest(raw))

    def test_physical_resource_link_and_windows_path_aliases_are_rejected(self):
        bundle=load('s4_bundle','windows_bundle.py')
        for path in ('../escape','C:/escape','a\\b','a/CON.txt','a.','a//b'):
            with self.subTest(path=path),self.assertRaisesRegex(ValueError,'path'):
                bundle.safe_relative(path)

    def test_file_resource_symlink_is_rejected(self):
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (path,sha),doc=fixture(root)
            self.assertEqual(len(bundle.admit_resources(path,sha)['files']),len(doc['files']))
            target=root/'payload'/doc['files'][0]['path']
            outside=root/'original'; target.rename(outside)
            try:
                try:
                    target.symlink_to(outside)
                except OSError as exc:
                    if exc.errno in (1,13) or getattr(exc,'winerror',None)==1314:
                        self.skipTest('file symlink creation permission denied')
                    raise
                with self.assertRaisesRegex(ValueError,'symlink/reparse'):
                    bundle.admit_resources(path,sha)
            finally:
                if target.is_symlink(): target.unlink()
                outside.rename(target)
            self.assertEqual(len(bundle.admit_resources(path,sha)['files']),len(doc['files']))

    def _assert_reparse_only_control(self, bundle, path, sha, directory):
        import stat
        from types import SimpleNamespace
        original=Path.lstat
        observed=directory.lstat()
        self.assertFalse(stat.S_ISLNK(observed.st_mode))
        self.assertTrue(observed.st_file_attributes & 0x400)
        with self.assertRaisesRegex(ValueError,'symlink/reparse'):
            bundle.admit_resources(path,sha)
        def without_reparse(p, *args, **kwargs):
            st=original(p,*args,**kwargs)
            if p==directory:
                fields={name:getattr(st,name) for name in dir(st) if name.startswith('st_')}
                fields['st_file_attributes']=getattr(st,'st_file_attributes',0) & ~0x400
                return SimpleNamespace(**fields)
            return st
        # Disable only this directory's reparse bit, never the symlink/type checks.
        with patch.object(Path,'lstat',without_reparse):
            self.assertTrue(bundle.admit_resources(path,sha)['files'])

    def test_directory_reparse_metadata_only_is_discriminated(self):
        from types import SimpleNamespace
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (path,sha),doc=fixture(root)
            self.assertEqual(len(bundle.admit_resources(path,sha)['files']),len(doc['files']))
            directory=root/'payload'/VENDOR
            self.assertFalse(any(p.is_symlink() for p in directory.rglob('*')))
            original=Path.lstat
            def reparse_metadata(p,*args,**kwargs):
                st=original(p,*args,**kwargs)
                if p==directory:
                    fields={name:getattr(st,name) for name in dir(st) if name.startswith('st_')}
                    fields['st_file_attributes']=getattr(st,'st_file_attributes',0) | 0x400
                    return SimpleNamespace(**fields)
                return st
            # Metadata double over real regular files, NOT a native junction.
            with patch.object(Path,'lstat',reparse_metadata):
                self._assert_reparse_only_control(bundle,path,sha,directory)

    @unittest.skipUnless(sys.platform=='win32', 'Windows-only native directory junction')
    def test_directory_junction_is_rejected(self):
        import _winapi
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (path,sha),doc=fixture(root)
            self.assertEqual(len(bundle.admit_resources(path,sha)['files']),len(doc['files']))
            vendor_dir=root/'payload'/VENDOR; real_vendor=root/'real_vendor'
            self.assertFalse(any(p.is_symlink() for p in vendor_dir.rglob('*')))
            vendor_dir.rename(real_vendor)
            try:
                try:
                    _winapi.CreateJunction(str(real_vendor),str(vendor_dir))
                except OSError as exc:
                    if exc.errno in (1,13) or getattr(exc,'winerror',None)==1314:
                        self.skipTest('directory junction creation permission denied')
                    raise
                self._assert_reparse_only_control(bundle,path,sha,vendor_dir)
            finally:
                # rmdir removes our junction itself; never recurse through its target.
                if vendor_dir.exists(): vendor_dir.rmdir()
                real_vendor.rename(vendor_dir)
            self.assertEqual(len(bundle.admit_resources(path,sha)['files']),len(doc['files']))

    def test_lock_hash_record_tag_and_extra_wheels_have_distinct_rejections(self):
        import zipfile
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); house,lock=public_fixture(root); wheel=next(house.iterdir())
            bundle.admit_wheelhouse(lock,house)
            good=lock.read_text()
            for text in ('--extra-index-url https://invalid.example/\n', 'sample>=1\n',
                         'soundfile==1 --hash=sha256:'+'0'*64+'\n', good+good):
                lock.write_text(text)
                with self.subTest(text=text),self.assertRaisesRegex(ValueError,'lock'):
                    bundle.parse_lock(lock)
            lock.write_text('sample==1.0 --hash=sha256:'+'0'*64+'\n')
            with self.assertRaisesRegex(ValueError,'not hash locked'):
                bundle.admit_wheelhouse(lock,house)
            lock.write_text(good)
            foreign=house/'sample-1.0-cp312-cp312-win_amd64.whl'; foreign.write_bytes(wheel.read_bytes())
            with self.assertRaisesRegex(ValueError,'wrong Windows'):
                bundle.wheel_inventory(foreign)
            foreign.unlink()
            extra=house/'unexpected.txt'; extra.write_text('not a wheel')
            with self.assertRaisesRegex(ValueError,'only exact wheels'):
                bundle.admit_wheelhouse(lock,house)
            extra.unlink()
            with zipfile.ZipFile(wheel,'a') as archive: archive.writestr('sample/unrecorded.py',b'# no RECORD')
            with self.assertRaisesRegex(ValueError,'RECORD missing'):
                bundle.wheel_inventory(wheel)

    def test_prepared_source_is_revalidated_before_build_and_collection_is_exact(self):
        from types import SimpleNamespace
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); inputs=root/'inputs'; inputs.mkdir(); (path,sha),doc=fixture(inputs)
            house,lock=public_fixture(root); prepared=root/'prepared'; bundle.prepare(path,sha,house,prepared,lock)
            plan=bundle.verify_prepared(path,sha,house,prepared,lock)
            rows=[(str(Path(dest)/Path(src).name),src,'DATA') for src,dest in plan['datas']]
            analysis=SimpleNamespace(pure=[],binaries=[],datas=rows)
            bundle.validate_collection(analysis,plan)
            analysis.datas=rows[1:]
            with self.assertRaisesRegex(ValueError,'collected resource'):
                bundle.validate_collection(analysis,plan)
            analysis.datas=rows; analysis.binaries=[('libespeak-ng.dll','unread','BINARY')]
            with self.assertRaisesRegex(ValueError,'forbidden collected'):
                bundle.validate_collection(analysis,plan)
            victim=prepared/'source'/doc['files'][0]['path']; victim.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'prepared source content'):
                bundle.verify_prepared(path,sha,house,prepared,lock)

    def test_native_build_gate_is_exact_and_has_a_positive_isolated_control(self):
        bundle=load('s4_bundle','windows_bundle.py')
        with patch('platform.system',return_value='Windows'), patch('platform.machine',return_value='AMD64'), \
                patch('platform.python_implementation',return_value='CPython'), patch('struct.calcsize',return_value=8), \
                patch.object(sys,'version_info',(3,11,15)), patch.object(sys,'prefix','fixture-venv'), \
                patch.object(sys,'base_prefix','fixture-base'), patch.dict(os.environ,{},clear=True):
            self.assertIsNone(bundle.require_native())
            with patch('platform.machine',return_value='ARM64'),self.assertRaisesRegex(ValueError,'native Windows'):
                bundle.require_native()
            with patch.dict(os.environ,{'PYTHONPATH':'foreign'}),self.assertRaisesRegex(ValueError,'isolated'):
                bundle.require_native()

class ParentBoundaryTests(unittest.TestCase):
    def test_changed_resource_copy_cannot_write_beyond_admitted_size(self):
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); inputs=root/'inputs'; inputs.mkdir(); (path,sha),doc=fixture(inputs)
            admitted=bundle.admit_resources(path,sha)
            item=doc['files'][0]; victim=inputs/'payload'/item['path']
            victim.write_bytes(victim.read_bytes()+b'growth after admission')
            out=root/'partial'; out.mkdir()
            with self.assertRaisesRegex(ValueError,'copy|changed'):
                bundle.build_vendor(admitted,out)
            self.assertLessEqual((out/'source'/item['path']).stat().st_size,item['bytes'])

    def test_installed_uv_bookkeeping_is_inert_but_code_and_unknown_files_remain_bound(self):
        import zipfile
        from types import SimpleNamespace
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); house,lock=public_fixture(root); wheel=next(house.iterdir())
            info=bundle.wheel_inventory(wheel); site=root/'site'; site.mkdir()
            with zipfile.ZipFile(wheel) as archive: archive.extractall(site)
            dist=SimpleNamespace(metadata={'Name':'sample'},version='1.0',locate_file=lambda p:site/p)
            plan={'wheels':{'sample':info}}
            self.assertEqual(bundle.verify_installed(plan,[dist],[site]),{'sample':str(site)})
            (site/'sample-1.0.dist-info/uv_cache.json').write_text('{}')
            self.assertEqual(bundle.verify_installed(plan,[dist],[site]),{'sample':str(site)})
            victim=site/'sample/__init__.py'; original=victim.read_bytes(); victim.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'installed file differs'):
                bundle.verify_installed(plan,[dist],[site])
            victim.write_bytes(original)
            (site/'injected.pth').write_text('import forbidden')
            with self.assertRaisesRegex(ValueError,'unlocked installed file'):
                bundle.verify_installed(plan,[dist],[site])

    def test_locked_inert_hook_filename_is_not_a_forbidden_native_binary(self):
        bundle=load('s4_bundle','windows_bundle.py')
        with tempfile.TemporaryDirectory() as tmp:
            house,lock=public_fixture(Path(tmp)); wheel=next(house.iterdir())
            rewrite_wheel(wheel, {'sample/hooks/hook-cuda.py': b'# inert build hook fixture\n'})
            self.assertEqual(bundle.wheel_inventory(wheel)['name'],'sample')
            rewrite_wheel(wheel, {'sample.libs/cudart64_12.dll': b'forbidden native fixture'})
            with self.assertRaisesRegex(ValueError,'forbidden wheel content'):
                bundle.wheel_inventory(wheel)

if __name__ == '__main__':
    unittest.main()
