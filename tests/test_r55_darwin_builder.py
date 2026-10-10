"""Actual admission functions with filesystem fixtures; no runtime child."""
import base64,csv,hashlib,importlib.util,io,json,os,subprocess,sys,tempfile,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
def load(name,filename):
 spec=importlib.util.spec_from_file_location(name,ROOT/'spikes/packaged-runtime'/filename);module=importlib.util.module_from_spec(spec)
 changes=json.loads(Path(os.environ['R55_PY_MUTATION']).read_text()) if os.environ.get('R55_PY_MUTATION') else {}
 if filename in changes:exec(compile(Path(changes[filename]).read_text(),str(spec.origin),'exec'),module.__dict__)
 else:spec.loader.exec_module(module)
 return module
db=load('r55_builder','darwin_bundle.py')
def load_dependencies(name):
 spec=importlib.util.spec_from_file_location(name,ROOT/'scripts/r55-dependencies.py');module=importlib.util.module_from_spec(spec)
 changes=json.loads(Path(os.environ['R55_PY_MUTATION']).read_text()) if os.environ.get('R55_PY_MUTATION') else {}
 if 'scripts/r55-dependencies.py' in changes:exec(compile(Path(changes['scripts/r55-dependencies.py']).read_text(),str(spec.origin),'exec'),module.__dict__)
 else:spec.loader.exec_module(module)
 return module
def ident(raw):return {'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
class Admission(unittest.TestCase):
 def test_actual_spec_collect_basename_matches_builder_distpath(self):
  from types import SimpleNamespace
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   output=Path(d)/'build-output-005';collected=[];analysis=SimpleNamespace(pure=[],scripts=[],binaries=[],datas=[])
   def collect(*args,**kwargs):
    # The selected PyInstaller COLLECT constructor takes os.path.basename(name).
    collected.append(Path(db.packager_distpath(output))/os.path.basename(kwargs['name']))
    return object()
   args=['voice-runtime.spec','--darwin-wheelhouse',d,'--darwin-installation',d+'/installation.json','--darwin-mode','engineering','--darwin-output',str(output)]
   namespace={'SPECPATH':str(ROOT/'spikes/packaged-runtime'),'Analysis':lambda *a,**k:analysis,'PYZ':lambda *a:object(),'EXE':lambda *a,**k:object(),'COLLECT':collect}
   with patch.dict(sys.modules,{'darwin_bundle':db}),patch.object(db.platform,'system',return_value='Darwin'),patch.object(sys,'argv',args),patch.object(db,'require_native'),patch.object(db,'reviewed_source',return_value=('inert',{})),patch.object(db,'plan',return_value={'hiddenimports':[],'datas':[],'excludes':[]}),patch.object(db,'validate_collection',return_value={}),patch.object(db.support,'write_new'):
    exec(compile((ROOT/'spikes/packaged-runtime/voice-runtime.spec').read_bytes(),'voice-runtime.spec','exec'),namespace)
   self.assertEqual(collected,[output/'dist/runtime/bin'])
   # This otherwise-valid old distpath is the actual observed epoch004 defect.
   self.assertNotEqual(Path(output/'dist')/os.path.basename('runtime/bin'),collected[0])
 def test_complete_transitive_lock_and_missing_dependency_twin(self):
  lock=db.load_lock();self.assertEqual(len(lock['wheels']),66)
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   p=Path(d)/'bad.json';bad=dict(lock,wheels=lock['wheels'][:-1]);p.write_text(json.dumps(bad))
   with self.assertRaisesRegex(ValueError,'MISSING_TRANSITIVE'):db.load_lock(p)
   bad['constraints']={k:v for k,v in lock['constraints'].items() if k!='wrapt'};p.write_text(json.dumps(bad))
   with self.assertRaisesRegex(ValueError,'TRANSITIVE_CLOSURE'):db.load_lock(p)
 def test_real_zip_record_good_and_rehashed_bad_record_twin(self):
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   filename='sample-1.0-py3-none-any.whl';p=Path(d)/filename
   def make(bad=False):
    files={'sample.py':b'x=1\n','sample-1.0.dist-info/METADATA':b'Name: sample\nVersion: 1.0\n','sample-1.0.dist-info/WHEEL':b'Tag: py3-none-any\n'}
    rows=[(n,'sha256='+base64.urlsafe_b64encode(bytes.fromhex(ident(b)['sha256'])).rstrip(b'=').decode(),str(len(b)))for n,b in files.items()]
    if bad:rows[0]=(rows[0][0],rows[0][1],'999')
    rows.append(('sample-1.0.dist-info/RECORD','',''));stream=io.StringIO();csv.writer(stream).writerows(rows);files[rows[-1][0]]=stream.getvalue().encode()
    with zipfile.ZipFile(p,'w') as z:
     for n,b in files.items():z.writestr(n,b)
    return {'name':'sample','version':'1.0','filename':filename,**ident(p.read_bytes()),'tags':['py3-none-any'],'requiresDist':[]}
   expected=make();self.assertEqual(len(db.wheel_inventory(p,expected)['files']),4)
   wrong=dict(expected,requiresDistAuthority={'path':'sample-1.0.dist-info/METADATA','bytes':len(b'Name: sample\nVersion: 1.0\n'),'sha256':'f'*64})
   with self.assertRaisesRegex(ValueError,'METADATA_AUTHORITY'):db.wheel_inventory(p,wrong)
   with self.assertRaisesRegex(ValueError,'WHEEL_HASH'):db.wheel_inventory(p,dict(expected,sha256='a'*64))
   with self.assertRaisesRegex(ValueError,'FILENAME_ABI'):db.wheel_inventory(p,dict(expected,tags=['cp311-cp311-win_amd64']))
   with self.assertRaisesRegex(ValueError,'RECORD_HASH'):db.wheel_inventory(p,make(True))
 def test_installed_record_scope_hash_and_missing_row(self):
  import importlib.metadata
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   root=Path(d);site=root/'site';site.mkdir();scripts=root/'bin';scripts.mkdir();info=site/'sample-1.0.dist-info';info.mkdir()
   (root/'pyvenv.cfg').write_text('include-system-site-packages = false\n')
   bodies={'sample.py':b'x=1\n','sample-1.0.dist-info/METADATA':b'Name: sample\nVersion: 1.0\n'}
   for n,b in bodies.items():(site/n).write_bytes(b)
   items={n:ident(b)for n,b in bodies.items()};items['sample-1.0.dist-info/RECORD']={'bytes':0,'sha256':'0'*64}
   rows=[(n,'sha256='+base64.urlsafe_b64encode(bytes.fromhex(ident(b)['sha256'])).rstrip(b'=').decode(),str(len(b)))for n,b in bodies.items()];rows.append(('sample-1.0.dist-info/RECORD','',''))
   def record(values):stream=io.StringIO();csv.writer(stream).writerows(values);(info/'RECORD').write_text(stream.getvalue())
   class Dist:
    metadata={'Name':'sample'};version='1.0'
    def locate_file(self,p):return site/p
   (root/'venv-baseline.json').write_text(json.dumps({'bin':{},'config':db.identity(root/'pyvenv.cfg')}))
   with patch.object(importlib.metadata,'distributions',return_value=[Dist()]),patch.object(db.sysconfig,'get_path',side_effect=lambda name:str(scripts if name=='scripts' else site)),patch.object(db.sys,'prefix',str(root)),patch.object(db.support,'private_root',return_value=root):
    record(rows);self.assertEqual(db.verify_installed({'wheels':{'sample':{'version':'1.0','files':items}}}),{})
    record([*rows,('../../../foreign','',0)])
    with self.assertRaisesRegex(ValueError,'RECORD_SCOPE'):db.verify_installed({'wheels':{'sample':{'version':'1.0','files':items}}})
    wrong=[list(r) for r in rows];wrong[0][1]='sha256='+base64.urlsafe_b64encode(b'X'*32).rstrip(b'=').decode();record(wrong)
    with self.assertRaisesRegex(ValueError,'RECORD_HASH'):db.verify_installed({'wheels':{'sample':{'version':'1.0','files':items}}})
    record(rows[:-1])
    with self.assertRaisesRegex(ValueError,'RECORD_SET'):db.verify_installed({'wheels':{'sample':{'version':'1.0','files':items}}})
    body=b'import unauthorized_startup\n';(site/'evil.pth').write_bytes(body);items['evil.pth']=ident(body)
    h='sha256='+base64.urlsafe_b64encode(bytes.fromhex(ident(body)['sha256'])).rstrip(b'=').decode();record([*rows,('evil.pth',h,str(len(body)))])
    with self.assertRaisesRegex(ValueError,'UNAPPROVED_PTH'):db.verify_installed({'wheels':{'sample':{'version':'1.0','files':items}}})
 def test_arm64_binary_header_and_wrong_arch(self):
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   p=Path(d)/'macho';p.write_bytes(bytes.fromhex('cffaedfe0c000001')+b'\0'*32);self.assertEqual(db.macho_arches(p),[0x0100000c])
   p.write_bytes(b'plain');self.assertIsNone(db.macho_arches(p))
 def test_exact_coloredlogs_startup_requires_empty_environment_and_original_body(self):
  import importlib.metadata
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   root=Path(d);site=root/'site';site.mkdir();scripts=root/'bin';scripts.mkdir();info=site/'coloredlogs-15.0.1.dist-info';info.mkdir();(root/'pyvenv.cfg').write_text('include-system-site-packages = false\n')
   body=b'import os; exec(\'try: __import__("coloredlogs").auto_install() if os.environ.get("COLOREDLOGS_AUTO_INSTALL") else None\\nexcept ImportError: pass\')\n'
   (root/'venv-baseline.json').write_text(json.dumps({'bin':{},'config':db.identity(root/'pyvenv.cfg')}))
   def prepare(raw):
    bodies={'coloredlogs.pth':raw,'coloredlogs-15.0.1.dist-info/METADATA':b'Name: coloredlogs\nVersion: 15.0.1\n'}
    for n,b in bodies.items():(site/n).write_bytes(b)
    items={n:ident(b)for n,b in bodies.items()};items['coloredlogs-15.0.1.dist-info/RECORD']={'bytes':0,'sha256':'0'*64}
    rows=[(n,'sha256='+base64.urlsafe_b64encode(bytes.fromhex(ident(b)['sha256'])).rstrip(b'=').decode(),str(len(b)))for n,b in bodies.items()];rows.append(('coloredlogs-15.0.1.dist-info/RECORD','',''));stream=io.StringIO();csv.writer(stream).writerows(rows);(info/'RECORD').write_text(stream.getvalue())
    return {'wheels':{'coloredlogs':{'version':'15.0.1','files':items}}}
   plan=prepare(body)
   with patch.object(importlib.metadata,'distributions',return_value=[importlib.metadata.Distribution.at(info)]),patch.object(db.sysconfig,'get_path',side_effect=lambda name:str(scripts if name=='scripts' else site)),patch.object(db.sys,'prefix',str(root)),patch.object(db.support,'private_root',return_value=root),patch.dict(os.environ,{'COLOREDLOGS_AUTO_INSTALL':''}):
    self.assertEqual(db.verify_installed(plan)['coloredlogs.pth'],ident(body))
    with patch.dict(os.environ,{'COLOREDLOGS_AUTO_INSTALL':'0'}),self.assertRaisesRegex(ValueError,'UNAPPROVED_PTH'):db.verify_installed(plan)
    plan=prepare(body+b'# changed startup\n')
    with self.assertRaisesRegex(ValueError,'UNAPPROVED_PTH'):db.verify_installed(plan)
 def test_legacy_windows_branch_bytes_preserved(self):
  # The platform branch is assessed by the independent reviewer against START;
  # its original full validator remains shared, unchanged and exercised below.
  self.assertTrue(db.wb.forbidden_path('libespeak-ng.dll'))
  self.assertEqual(db.wb.safe_relative('bin/_internal/mlx/libmlx.dylib'),'bin/_internal/mlx/libmlx.dylib')
 def test_static_abi_load_commands_and_malformed_bounds(self):
  import struct
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   name=b'@rpath/libnumeric.dylib\0';size=(24+len(name)+7)//8*8
   dylib=struct.pack('<6I',0xc,size,24,0,0x10002,0x10000)+name+b'\0'*(size-24-len(name))
   build=struct.pack('<6I',0x32,24,1,0xd0000,0x1a0000,0);commands=dylib+build
   header=struct.pack('<8I',0xfeedfacf,0x100000c,0,6,2,len(commands),0,0);p=Path(d)/'fixture';p.write_bytes(header+commands)
   abi=db.macho_abi(p);self.assertEqual(abi['dependencies'][0]['name'],'@rpath/libnumeric.dylib');self.assertEqual(abi['buildVersions'][0]['minimumOS'],'13.0.0');self.assertFalse(abi['runtimeReaderQualification'])
   p.write_bytes(header+commands[:-1])
   with self.assertRaisesRegex(ValueError,'COMMAND_BOUND'):db.macho_abi(p)
 def test_exact_build_hook_python_source_does_not_admit_cuda_native(self):
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   filename='pyinstaller_hooks_contrib-2026.7-py3-none-any.whl';p=Path(d)/filename
   def make(suffix,name='pyinstaller-hooks-contrib'):
    nonlocal p
    filename=name.replace('-','_')+'-2026.7-py3-none-any.whl';p=Path(d)/filename
    info=name.replace('-','_')+'-2026.7.dist-info';files={'_pyinstaller_hooks_contrib/utils/nvidia_cuda.'+suffix:b'opaque hook fixture',info+'/METADATA':('Name: '+name+'\nVersion: 2026.7\n').encode(),info+'/WHEEL':b'Tag: py3-none-any\n'}
    rows=[(n,'sha256='+base64.urlsafe_b64encode(bytes.fromhex(ident(b)['sha256'])).rstrip(b'=').decode(),str(len(b)))for n,b in files.items()];rows.append((info+'/RECORD','',''));stream=io.StringIO();csv.writer(stream).writerows(rows);files[info+'/RECORD']=stream.getvalue().encode()
    with zipfile.ZipFile(p,'w') as z:
     for n,b in files.items():z.writestr(n,b)
    return {'name':name,'version':'2026.7','filename':filename,**ident(p.read_bytes()),'tags':['py3-none-any'],'requiresDist':[]}
   self.assertIn('_pyinstaller_hooks_contrib/utils/nvidia_cuda.py',db.wheel_inventory(p,make('py'))['files'])
   with self.assertRaisesRegex(ValueError,'FORBIDDEN_WHEEL'):db.wheel_inventory(p,make('so'))
   expected=make('py','unrelated')
   with self.assertRaisesRegex(ValueError,'FORBIDDEN_WHEEL'):db.wheel_inventory(p,expected)
   self.assertIn('_pyinstaller_hooks_contrib',db.EXCLUDES)
 def test_guard_actual_events_positive_and_negative_twins(self):
  with patch.dict(os.environ,{'R55_BUILD_GUARD':'0'}):guard=load('r55_guard','r55_build_guard.py')
  guard.audit('open',('code.py','r',0))
  for event,args in [('open',('weights.onnx','r',0)),('socket.connect',(object(),('example.test',443))),('subprocess.Popen',('/bin/sh',['/bin/sh','-c','echo bad'],None,{})),('os.fork',())]:
   with self.subTest(event=event),self.assertRaisesRegex(RuntimeError,'R55_'):guard.audit(event,args)
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d,patch.dict(os.environ,{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','R55_BUILD_OUTPUT':d}):
   valid=['/usr/bin/codesign','-s','-','--force','--all-architectures','--timestamp',d+'/candidate']
   guard.audit('subprocess.Popen',('/usr/bin/codesign',valid,None,dict(os.environ)))
   bad=[*valid[:-1],'/Applications/Original.app']
   with self.assertRaisesRegex(RuntimeError,'SCOPE'):guard.audit('subprocess.Popen',('/usr/bin/codesign',bad,None,dict(os.environ)))
 def test_engineering_plan_twin_and_production_d2_refusal(self):
  with self.assertRaisesRegex(ValueError,'PRODUCTION_RESOURCES_INCOMPLETE'):db.plan('unused','unused','production')
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   root=Path(d);house=root/'house';house.mkdir();installation=root/'installation.json'
   lock={'wheels':[],'kokoroSource':{'filename':'source.whl'},'d2Gaps':['real-missing-dictionary']}
   (house/'source.whl').write_bytes(b'only admitted fixture source')
   installation.write_text(json.dumps({'lockSha256':db.identity(db.LOCK)['sha256'],'localWheels':[]}))
   with patch.object(db,'load_lock',return_value=lock),patch.object(db,'verify_installed',return_value={}):
    result=db.plan(house,installation,'engineering')
    self.assertEqual(result['outputClass'],'ENGINEERING_CODE_ONLY_NOT_ACTIVATABLE');self.assertEqual(result['d2Gaps'],lock['d2Gaps'])
    installation.write_text(json.dumps({'lockSha256':'a'*64,'localWheels':[]}))
    with self.assertRaisesRegex(ValueError,'LOCK_DRIFT'):db.plan(house,installation,'engineering')
 def test_actual_collection_extension_namespace_and_wrong_resource_twins(self):
  from types import SimpleNamespace
  # Shared-library materialization has its own actual-function twins below;
  # this fixture exercises the independent namespace/resource collector.
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d,patch.object(db,'materialize_existing_python_library',return_value={'inertFixture':True}):
   root=Path(d);source=root/'code.py';source.write_text('x=1');binary=root/'core.so';binary.write_bytes(b'native fixture')
   data=root/'LICENSE';data.write_text('license')
   analysis=SimpleNamespace(pure=[('mlx',str(source),'PYMODULE'),('tiktoken_ext',None,'PYMODULE'),('tiktoken_ext.openai_public',str(source),'PYMODULE')],binaries=[('mlx/core.cpython-311-darwin.so',str(binary),'EXTENSION')],datas=[('notices/LICENSE',str(data),'DATA')],scripts=[('entry',str(source),'PYSOURCE')])
   plan={'datas':[(str(data),'notices')]}
   collection=db.validate_collection(analysis,plan)
   self.assertIn('mlx.core',collection['pythonModules']);self.assertEqual(collection['pythonSourceInputs']['tiktoken_ext']['kind'],'PEP420_NAMESPACE')
   analysis.binaries=[];self.assertNotIn('mlx.core',db.validate_collection(analysis,plan)['pythonModules'])
   analysis.datas=[]
   with self.assertRaisesRegex(ValueError,'RESOURCE_COLLECTION_DRIFT'):db.validate_collection(analysis,plan)
 def test_custody_deadline_unknown_is_sticky_after_late_close_and_closed_fd_is_not_eof(self):
  custody=load('r55_custody','r55_tool_custody.py');self.addCleanup(lambda:custody.records.clear())
  class Closed:
   closed=True
  class Handle:
   pid=123;returncode=0;stdin=None;stdout=Closed();stderr=Closed()
   def poll(self):return 0
   def wait(self,timeout=0):return 0
  custody.records.append({'handle':Handle(),'argv':['fixed'], 'started':True,'noSpawn':False,'drained':{'stdout':False,'stderr':False}})
  self.assertFalse(custody.close_originals(__import__('time').monotonic()+.01))
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d,patch.dict(os.environ,{'R55_CANONICAL_PRIVATE':d,'R55_TOOL_RECEIPTS':d}),patch.object(custody,'enable'):
   with self.assertRaisesRegex(RuntimeError,'CLOSURE_UNKNOWN'):custody.supervise(lambda:None,10)
   self.assertTrue(custody.unknown);self.assertTrue(list(Path(d).glob('infrastructure-*-unknown.json')))
   custody.records[0]['drained']={'stdout':True,'stderr':True}
   with self.assertRaisesRegex(RuntimeError,'STICKY_TOOL_UNKNOWN'):custody.supervise(lambda:self.fail('late dispatch'),10)
  custody.records.clear()
 def test_actual_review_source_and_lock_drift_twins(self):
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   root=Path(d);script=root/'spec.py';script.write_text('immutable spec input')
   code='c'*40;gate={'code':code,'decision':'PASS','lockSha256':db.identity(db.LOCK)['sha256'],'sourceFiles':{'spec.py':db.identity(script)['sha256']}}
   file=root/('source-admission-'+code+'.json');file.write_text(json.dumps(gate))
   with patch.object(db.support,'private_root',return_value=root),patch.object(db.subprocess,'check_output',return_value=(code+'\n').encode()),patch.object(db,'ROOT',root):
    self.assertEqual(db.reviewed_source()[0],code)
    script.write_text('changed spec input')
    with self.assertRaisesRegex(ValueError,'REVIEWED_SOURCE_DRIFT'):db.reviewed_source()
    gate['lockSha256']='b'*64;file.write_text(json.dumps(gate))
    with self.assertRaisesRegex(ValueError,'SOURCE_REVIEW_REQUIRED'):db.reviewed_source()
 def test_storage_failure_cannot_skip_original_handle_retention(self):
  custody=load('r55_storage_custody','r55_tool_custody.py');self.addCleanup(lambda:custody.records.clear())
  class Handle:
   pid=123;returncode=None;closed=False
   def poll(self):return 0 if self.closed else None
  handle=Handle();custody.records=[{'handle':handle,'argv':['fixed'],'started':True,'noSpawn':False,'drained':{}}]
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d,patch.dict(os.environ,{'R55_CANONICAL_PRIVATE':d}),patch.object(custody,'close_originals',return_value=False),patch.object(custody,'write_receipt',side_effect=OSError('ENOSPC')),patch.object(custody.time,'sleep',side_effect=lambda _:setattr(handle,'closed',True)):
   with self.assertRaisesRegex(OSError,'ENOSPC'):custody.finalize(1,'test')
   self.assertTrue(handle.closed);self.assertTrue(custody.unknown);self.assertTrue(custody.revoked)
  custody.records.clear()
 def test_adjacent_installer_loader_registers_custody_before_guard_import(self):
  spec=importlib.util.spec_from_file_location('r55_dependencies_test',ROOT/'scripts/r55-dependencies.py');module=importlib.util.module_from_spec(spec)
  saved=list(sys.path)
  try:
   spec.loader.exec_module(module)
   with patch.dict(sys.modules,{}),patch.dict(os.environ,{'R55_BUILD_GUARD':'0'}):
    custody=module.module('r55_tool_custody');guard=module.module('r55_build_guard')
    self.assertIs(sys.modules['r55_tool_custody'],custody);self.assertIs(sys.modules['r55_build_guard'],guard)
  finally:sys.path[:]=saved
 def test_actual_pip_parser_cannot_accept_ambient_redirect_configuration(self):
  saved=list(sys.path)
  try:
   module=load_dependencies('r55_install_isolation')
   from pip._internal.cli.main_parser import parse_command
   from pip._internal.commands import create_command
   with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
    root=Path(d);config=root/'host-pip.conf';config.write_text('[install]\ntarget = '+str(root/'outside')+'\n');parent={'PIP_CONFIG_FILE':str(config),'PIP_PREFIX':str(root/'other-prefix'),'PIP_TARGET':str(root/'outside'),'PIP_USER':'1','PIP_ROOT':str(root/'other-root'),'PIP_FIND_LINKS':'https://unreviewed.invalid/wheels','PYTHONPATH':'unreviewed','R55_BUILD_OUTPUT':'foreign'}
    args=module.installer_arguments(root,{'wheelhouse':str(root/'approved-house')})
    def parse():
     name,argv=parse_command(args);return create_command(name).parse_args(argv)[0]
    with patch.dict(os.environ,parent,clear=True):self.assertEqual(parse().target_dir,str(root/'outside'))
    env=module.installer_environment(root,parent)
    with patch.dict(os.environ,env,clear=True):
     options=parse();self.assertIsNone(options.target_dir);self.assertIsNone(options.prefix_path);self.assertIsNone(options.root_path);self.assertIsNone(options.use_user_site);self.assertTrue(options.no_index);self.assertTrue(options.ignore_dependencies);self.assertTrue(options.require_hashes);self.assertEqual(options.find_links,[str(root/'approved-house')]);self.assertEqual(options.cache_dir,str(root/'install-caches/pip'))
    self.assertEqual(env['PIP_CONFIG_FILE'],os.devnull);self.assertNotIn('PYTHONPATH',env);self.assertNotIn('R55_BUILD_OUTPUT',env)
  finally:sys.path[:]=saved
 def test_existing_interpreter_alias_must_resolve_before_venv_creation(self):
  saved=list(sys.path)
  try:
   module=load_dependencies('r55_existing_python')
   with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
    root=Path(d);actual=root/'actual-python';actual.write_bytes(b'existing interpreter fixture');alias=root/'python-alias';alias.symlink_to(actual)
    receipt={'python':{'executable':{'path':str(actual),**ident(actual.read_bytes())}}};(root/'existing-toolchain.json').write_text(json.dumps(receipt))
    with patch.object(module.sys,'executable',str(alias)):
     try:command=module.venv_creation_command(root)
     except ValueError as error:self.fail('valid existing interpreter alias must resolve: '+str(error))
     self.assertEqual(command[0],str(actual));self.assertEqual(command[1:],['-I','-B','-m','venv','--copies','--without-pip',str(root/'venv')])
     actual.write_bytes(b'changed executable')
     with self.assertRaisesRegex(ValueError,'INTERPRETER_DRIFT'):module.venv_creation_command(root)
  finally:sys.path[:]=saved
 def test_empty_venv_repair_is_bound_to_original_failure_and_exact_pip_tree(self):
  saved=list(sys.path)
  try:
   module=load_dependencies('r55_empty_repair')
   for case in ('positive','nonempty','config','bin','command','closure','receipt','claimed','pip-extra','review-drift'):
    with self.subTest(case=case),tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
     root=Path(d);venv=root/'venv';(venv/'bin').mkdir(parents=True);(venv/'lib/python3.11/site-packages').mkdir(parents=True);(venv/'bin/python').write_bytes(b'copied existing python');(venv/'pyvenv.cfg').write_text('old alias home\n')
     def put(name,value): (root/name).write_text(json.dumps(value))
     put('venv-baseline.json',{'bin':module.db.wb.tree(venv/'bin'),'config':ident((venv/'pyvenv.cfg').read_bytes())})
     command=[str(venv/'bin/python'),'-I','-B',str(module.__file__),'install-payload']
     for i in (0,1):
      put('install-'+str(i)+'-result.json',{'exit':i,'closure':'CLOSED','bothDrained':True,'overflow':[],'command':command});(root/('install-'+str(i)+'.stdout')).write_bytes(b'');(root/('install-'+str(i)+'.stderr')).write_bytes(b"ModuleNotFoundError: No module named 'encodings'" if i else b'')
     (root/'install-tool-receipts').mkdir();put('install-tool-receipts/supervision.json',{'closure':'CLOSED','children':[{'noSpawn':False,'reaped':True,'drained':{'stdout':True,'stderr':True}}]})
     (root/'installer-code/pip').mkdir(parents=True);raw=b'original pip code';(root/'installer-code/pip/__init__.py').write_bytes(raw);put('preparation.json',{'wheelRecordInventories':{'pip':{'files':{'pip/__init__.py':ident(raw)}}}})
     evidence=['venv-baseline.json','venv/pyvenv.cfg','venv/bin/python','install-tool-receipts/supervision.json',*[f'install-{i}{suffix}' for i in (0,1) for suffix in ('-result.json','.stdout','.stderr')]]
     if case=='nonempty':(venv/'lib/python3.11/site-packages/foreign.py').write_text('x=1')
     if case=='config':(venv/'pyvenv.cfg').write_text('foreign')
     if case=='bin':(venv/'bin/python').write_bytes(b'foreign')
     if case=='command':put('install-1-result.json',{'exit':1,'closure':'CLOSED','bothDrained':True,'overflow':[],'command':['foreign']})
     if case=='closure':put('install-1-result.json',{'exit':1,'closure':'UNKNOWN','bothDrained':True,'overflow':[],'command':command})
     if case=='receipt':put('install-tool-receipts/supervision.json',{'closure':'CLOSED','children':[{'noSpawn':False,'reaped':False,'drained':{'stdout':True,'stderr':True}}]})
     if case=='claimed':put('venv-repair-001-claim.json',{})
     if case=='pip-extra':(root/'installer-code/pip/foreign.py').write_text('x=1')
     gate={'priorRepairFiles':{p:ident((root/p).read_bytes())['sha256'] for p in evidence}}
     if case=='review-drift':gate['priorRepairFiles']['install-1.stderr']='0'*64
     with patch.object(module,'venv_creation_command',return_value=['fixed existing interpreter']):
      if case=='positive':
       module.admit_empty_venv_repair(root,gate);self.assertTrue((root/'venv-repair-001-claim.json').exists());self.assertEqual((venv/'pyvenv.cfg').read_text(),'old alias home\n')
      else:
       with self.assertRaisesRegex(ValueError,'R55_REPAIR_'):module.admit_empty_venv_repair(root,gate)
       if case!='claimed':self.assertFalse((root/'venv-repair-001-claim.json').exists())
  finally:sys.path[:]=saved
 def test_repaired_venv_baseline_requires_all_original_linkage_hashes(self):
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   root=Path(d);old={'bin':{},'config':{'sha256':'old'}};new={'bin':{},'config':{'sha256':'new'}}
   (root/'venv-baseline.json').write_text(json.dumps(old));self.assertEqual(db.venv_baseline(root),old)
   (root/'venv-baseline-repaired.json').write_text(json.dumps(new));(root/'venv-repair-001-claim.json').write_text('{}')
   good={'closure':'CLOSED','oldBaselineSha256':ident((root/'venv-baseline.json').read_bytes())['sha256'],'newBaselineSha256':ident((root/'venv-baseline-repaired.json').read_bytes())['sha256'],'claimSha256':ident((root/'venv-repair-001-claim.json').read_bytes())['sha256']}
   for field in (*good,):
    bad=dict(good);bad[field]='UNKNOWN' if field=='closure' else '0'*64;(root/'venv-repair-001-result.json').write_text(json.dumps(bad))
    with self.assertRaisesRegex(ValueError,'REPAIR_BINDING'):db.venv_baseline(root)
   (root/'venv-repair-001-result.json').write_text(json.dumps(good));self.assertEqual(db.venv_baseline(root),new)
 def test_exact_wheel_script_shebang_relocation_keeps_every_other_byte_bound(self):
  import importlib.metadata
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   root=Path(d);site=root/'site';site.mkdir();scripts=root/'bin';scripts.mkdir();(root/'pyvenv.cfg').write_text('cfg');info=site/'numba-0.61.2.dist-info';info.mkdir()
   member='numba-0.61.2.data/scripts/numba';raw=b'#!python\nimport numba.misc.numba_entry\n';wheel=root/'numba.whl'
   with zipfile.ZipFile(wheel,'w') as archive:archive.writestr(member,raw)
   meta=b'Name: numba\nVersion: 0.61.2\n';(info/'METADATA').write_bytes(meta);files={member:ident(raw),'numba-0.61.2.dist-info/METADATA':ident(meta),'numba-0.61.2.dist-info/RECORD':ident(b'')}
   plan={'wheels':{'numba':{'version':'0.61.2','path':str(wheel),'identity':ident(wheel.read_bytes()),'files':files}}}
   expected=b'#!'+os.fsencode(sys.executable)+b'\n'+raw.split(b'\n',1)[1];(scripts/'numba').write_bytes(expected)
   (root/'venv-baseline.json').write_text(json.dumps({'bin':{},'config':ident((root/'pyvenv.cfg').read_bytes())}))
   rows=[('../bin/numba','sha256='+base64.urlsafe_b64encode(bytes.fromhex(ident(expected)['sha256'])).rstrip(b'=').decode(),str(len(expected))),('numba-0.61.2.dist-info/METADATA','sha256='+base64.urlsafe_b64encode(bytes.fromhex(ident(meta)['sha256'])).rstrip(b'=').decode(),str(len(meta))),('numba-0.61.2.dist-info/RECORD','','')];stream=io.StringIO();csv.writer(stream).writerows(rows);(info/'RECORD').write_text(stream.getvalue())
   with patch.object(importlib.metadata,'distributions',return_value=[importlib.metadata.Distribution.at(info)]),patch.object(db.sysconfig,'get_path',side_effect=lambda name:str(scripts if name=='scripts' else site)),patch.object(db.sys,'prefix',str(root)),patch.object(db.support,'private_root',return_value=root):
    normalized,proof=db.script_relocations(plan);self.assertEqual(normalized['wheels']['numba']['files'][member],ident(expected));self.assertEqual(plan['wheels']['numba']['files'][member],ident(raw));self.assertEqual(proof[str(scripts/'numba')]['original'],ident(raw));self.assertEqual(db.verify_installed(plan),{})
    (scripts/'numba').write_bytes(expected+b'import unauthorized\n')
    with self.assertRaisesRegex(ValueError,'differs from locked wheel'):db.verify_installed(plan)
    (scripts/'numba').write_bytes(b'#!/foreign/python\n'+raw.split(b'\n',1)[1])
    with self.assertRaisesRegex(ValueError,'differs from locked wheel'):db.verify_installed(plan)
    (scripts/'numba').write_bytes(expected);(scripts/'foreign').write_text('unowned')
    with self.assertRaisesRegex(ValueError,'BIN_DRIFT'):db.verify_installed(plan)
    (scripts/'foreign').unlink()
    def record(values):stream=io.StringIO();csv.writer(stream).writerows(values);(info/'RECORD').write_text(stream.getvalue())
    wrong=[list(r) for r in rows];wrong[0][1]='sha256='+base64.urlsafe_b64encode(b'X'*32).rstrip(b'=').decode();record(wrong)
    with self.assertRaisesRegex(ValueError,'RECORD_HASH'):db.verify_installed(plan)
    record([*rows,('../bin/foreign','','')])
    with self.assertRaisesRegex(ValueError,'RECORD_SCOPE'):db.verify_installed(plan)
    record(rows)
    with self.assertRaisesRegex(ValueError,'RELOCATION_SCOPE'):db.script_relocations({'wheels':{'foreign':plan['wheels']['numba']}})
    wrong=json.loads(json.dumps(plan));wrong['wheels']['numba']['files'][member+'-foreign']=wrong['wheels']['numba']['files'].pop(member)
    with self.assertRaisesRegex(ValueError,'RELOCATION_SCOPE'):db.script_relocations(wrong)
    wrong=json.loads(json.dumps(plan));wrong['wheels']['numba']['identity']['sha256']='0'*64
    with self.assertRaisesRegex(ValueError,'WHEEL_DRIFT'):db.script_relocations(wrong)
    plan['wheels']['numba']['files'][member]=ident(b'foreign source')
    with self.assertRaisesRegex(ValueError,'SCRIPT_SOURCE_DRIFT'):db.script_relocations(plan)
 def test_selected_pip_console_template_and_foreign_body_twin(self):
  import importlib.metadata
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   root=Path(d);site=root/'site';site.mkdir();scripts=root/'bin';scripts.mkdir();info=site/'sample-1.0.dist-info';info.mkdir();(root/'pyvenv.cfg').write_text('cfg')
   files={'sample.py':b'def main(): return 0\n','sample-1.0.dist-info/METADATA':b'Name: sample\nVersion: 1.0\n','sample-1.0.dist-info/entry_points.txt':b'[console_scripts]\nsample-cli = sample:main\n'}
   for p,b in files.items():(site/p).write_bytes(b)
   items={p:ident(b) for p,b in files.items()};items['sample-1.0.dist-info/RECORD']=ident(b'')
   body=('#!'+sys.executable+"\nimport sys\nfrom sample import main\nif __name__ == '__main__':\n    sys.argv[0] = sys.argv[0].removesuffix('.exe')\n    sys.exit(main())\n").encode();(scripts/'sample-cli').write_bytes(body)
   rows=[(p,'sha256='+base64.urlsafe_b64encode(bytes.fromhex(ident(b)['sha256'])).rstrip(b'=').decode(),str(len(b))) for p,b in {**files,'../bin/sample-cli':body}.items()];rows.append(('sample-1.0.dist-info/RECORD','',''));stream=io.StringIO();csv.writer(stream).writerows(rows);(info/'RECORD').write_text(stream.getvalue());(root/'venv-baseline.json').write_text(json.dumps({'bin':{},'config':ident((root/'pyvenv.cfg').read_bytes())}))
   plan={'wheels':{'sample':{'version':'1.0','files':items}}}
   with patch.object(importlib.metadata,'distributions',return_value=[importlib.metadata.Distribution.at(info)]),patch.object(db.sysconfig,'get_path',side_effect=lambda name:str(scripts if name=='scripts' else site)),patch.object(db.sys,'prefix',str(root)),patch.object(db.support,'private_root',return_value=root):
    try:startup=db.verify_installed(plan)
    except ValueError as error:self.fail('exact selected pip console template must verify: '+str(error))
    self.assertEqual(startup,{})
    (scripts/'sample-cli').write_bytes(body+b'import unauthorized\n')
    with self.assertRaisesRegex(ValueError,'CONSOLE_SCRIPT_BYTES'):db.verify_installed(plan)
    (scripts/'sample-cli').unlink();stream=io.StringIO();csv.writer(stream).writerows([r for r in rows if r[0]!='../bin/sample-cli']);(info/'RECORD').write_text(stream.getvalue())
    with self.assertRaisesRegex(ValueError,'CONSOLE_SCRIPT_MISSING'):db.verify_installed(plan)
 def test_embedded_record_cannot_change_with_rehashed_outer_record(self):
  import importlib.metadata
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
   root=Path(d);site=root/'site';site.mkdir();scripts=root/'bin';scripts.mkdir();info=site/'sample-1.0.dist-info';info.mkdir();(root/'pyvenv.cfg').write_text('cfg')
   embedded='sample/vendor/inner-2.0.dist-info/RECORD';files={'sample.py':b'x=1\n','sample-1.0.dist-info/METADATA':b'Name: sample\nVersion: 1.0\n',embedded:b'original,sha256=original,8\n'}
   for p,b in files.items():(site/p).parent.mkdir(parents=True,exist_ok=True);(site/p).write_bytes(b)
   items={p:ident(b) for p,b in files.items()};items['sample-1.0.dist-info/RECORD']=ident(b'');plan={'wheels':{'sample':{'version':'1.0','files':items}}}
   def rewrite():
    rows=[(p,'sha256='+base64.urlsafe_b64encode(bytes.fromhex(ident((site/p).read_bytes())['sha256'])).rstrip(b'=').decode(),str((site/p).stat().st_size)) for p in files];rows.append(('sample-1.0.dist-info/RECORD','',''));stream=io.StringIO();csv.writer(stream).writerows(rows);(info/'RECORD').write_text(stream.getvalue())
   rewrite();(root/'venv-baseline.json').write_text(json.dumps({'bin':{},'config':ident((root/'pyvenv.cfg').read_bytes())}))
   with patch.object(importlib.metadata,'distributions',return_value=[importlib.metadata.Distribution.at(info)]),patch.object(db.sysconfig,'get_path',side_effect=lambda name:str(scripts if name=='scripts' else site)),patch.object(db.sys,'prefix',str(root)),patch.object(db.support,'private_root',return_value=root):
    self.assertEqual(db.verify_installed(plan),{})
    (site/embedded).write_bytes(b'forged,sha256=forged,6\n');rewrite()
    with self.assertRaisesRegex(ValueError,'EMBEDDED_RECORD_DRIFT'):db.verify_installed(plan)
 def test_entire_build_epoch_has_one_owner_deadline_across_plan_and_postchecks(self):
  from types import SimpleNamespace
  import importlib.metadata
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d,patch.dict(os.environ,{}):
   root=Path(d);base=root/'base';(base/'lib/python3.11').mkdir(parents=True);(base/'lib/python3.11/LICENSE.txt').write_text('existing license');python=root/'existing-python';python.write_bytes(b'existing interpreter fixture');installation=root/'installation.json';installation.write_text(json.dumps({'localWheels':[]}));output=root/'build-output-001';events=[];state={'active':False,'supervisions':0}
   def supervised(call,seconds):
    self.assertLessEqual(seconds,3600);self.assertFalse(state['active']);state.update(active=True,supervisions=state['supervisions']+1)
    try:return call()
    finally:state['active']=False
   def active(name):self.assertTrue(state['active'],name+' outside owner deadline');events.append(name)
   custody=SimpleNamespace(supervise=supervised,finalize=lambda deadline,label:active(label),records=[],unknown=False,projection=lambda:[])
   before={'wheels':{},'lockSha256':'l'*64,'installationSha256':'i'*64}
   def plan(*args):active('plan');return before
   def reviewed():active('source-git');return ('c'*40,{'sourceFiles':{},'existingToolchain':{'appleTools':{'/usr/bin/install_name_tool':{'path':'/usr/bin/install_name_tool',**db.wb.read_checked(Path('/usr/bin/install_name_tool'))[0]}}},'platformPreflightSha256':'p'*64})
   def run(args):
    active('packager');runtime=output/'dist/runtime';runtime.mkdir(parents=True);db.support.write_new(output/'collection.json',db.support.encoded({'requiredCode':[],'pythonModules':[],'sourceToCollected':{}}))
   def post(*args):active('post-abi-inventory');return {'files':{},'outputClass':'ENGINEERING_CODE_ONLY_NOT_ACTIVATABLE'}
   with patch.dict(sys.modules,{'r55_tool_custody':custody,'PyInstaller.__main__':SimpleNamespace(run=run)}),patch.object(db,'require_native'),patch.object(db,'prime_platform_metadata',side_effect=lambda *args:active('platform-receipt')),patch.object(db,'reviewed_source',side_effect=reviewed),patch.object(db,'plan',side_effect=plan),patch.object(db,'post_build',side_effect=post),patch.object(db,'load_lock',return_value={'wheels':[]}),patch.object(db.support,'private_root',return_value=root),patch.object(db.sys,'base_prefix',str(base)),patch.object(db.sys,'executable',str(python)),patch.object(importlib.metadata,'version',return_value='6.22.3'):
    def dispatch():active('earliest-admission');return db.build(root/'house',installation,output,'engineering')
    result=db.supervised_epoch(dispatch)
   self.assertEqual(state['supervisions'],1);self.assertEqual(events.count('plan'),2);self.assertEqual(events.count('packager'),1);self.assertIn('post-abi-inventory',events);self.assertIn('pre-receipt',events);self.assertEqual(result['wholeEpochDeadlineSeconds'],3600);self.assertEqual(json.loads((root/'build-001-result.json').read_text())['closure'],'CLOSED');self.assertIsNone(db._epoch_deadline)
 def test_platform_cache_requires_original_receipt_and_live_snapshot(self):
  import platform
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d,patch.object(platform,'_uname_cache',None),patch.object(platform,'_platform_cache',{}):
   root=Path(d);python=str(Path(sys.executable).resolve());source=str(Path(platform.__file__).resolve())
   inputs={p:db.identity(Path(p)) for p in [python,source,'/usr/bin/uname','/usr/bin/file','/System/Library/CoreServices/SystemVersion.plist']}
   tools=[]
   for name,argv,raw in [('uname',['uname','-p'],b'arm\n'),('file',['file','-b',python],b'Mach-O 64-bit executable arm64\n')]:
    leaf='platform-preflight-001-'+name+'.stdout';(root/leaf).write_bytes(raw);tools.append({'argv':argv,'exit':0,'reaped':True,'bothDrained':True,'stdoutPath':leaf,'stdout':ident(raw)})
   receipt={'inputs':inputs,'closure':'CLOSED','exit':0,'uname':list(os.uname()),'macVersion':list(platform.mac_ver()),'pythonExecutable':python,'platformSource':source,'tools':tools,'processor':'arm','platform':'unit-fixture-platform'}
   path=root/'platform-preflight-001.json';path.write_bytes(db.support.encoded(receipt));gate={'platformPreflightSha256':db.identity(path)['sha256']}
   with patch.object(subprocess,'Popen',side_effect=AssertionError('cache must never dispatch')):db.prime_platform_metadata(root,gate);self.assertEqual(platform.platform(),'unit-fixture-platform')
   forged=dict(receipt,platform='forged-nonempty-platform');path.write_bytes(db.support.encoded(forged))
   with self.assertRaisesRegex(ValueError,'RECEIPT_BINDING'):db.prime_platform_metadata(root,gate)
   forged=dict(receipt,uname=['stale']*5);path.write_bytes(db.support.encoded(forged));gate={'platformPreflightSha256':db.identity(path)['sha256']}
   with self.assertRaisesRegex(ValueError,'SNAPSHOT_DRIFT'):db.prime_platform_metadata(root,gate)
 def test_platform_metadata_cleanup_uses_original_owner_deadline(self):
  from types import SimpleNamespace
  filename='scripts/r55-platform-preflight.py';spec=importlib.util.spec_from_file_location('r55_metadata_test',ROOT/filename);module=importlib.util.module_from_spec(spec)
  changes=json.loads(Path(os.environ['R55_PY_MUTATION']).read_text()) if os.environ.get('R55_PY_MUTATION') else {}
  with patch.dict(os.environ,{'R55_CANONICAL_PRIVATE':'/unit-fixture-private'}):
   if filename in changes:exec(compile(Path(changes[filename]).read_text(),str(spec.origin),'exec'),module.__dict__)
   else:spec.loader.exec_module(module)
  calls=[]
  with patch.object(module,'custody',SimpleNamespace(finalize=lambda deadline,label:calls.append((deadline,label)))),patch.object(module,'deadline',102.0),patch.object(module.time,'monotonic',return_value=101.0):module.settle_metadata()
  self.assertEqual(calls,[(102.0,'pre-receipt')])
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d,patch.object(module,'ROOT',Path(d)):
   file=Path(d)/'custody.py';file.write_bytes(b'original source');gate={'sourceFiles':{'custody.py':ident(file.read_bytes())['sha256']}}
   module.require_sources(gate);file.write_bytes(b'changed source')
   with self.assertRaisesRegex(ValueError,'SOURCE_DRIFT'):module.require_sources(gate)
 def test_only_pinned_existing_python_library_gets_owned_materialization(self):
  from types import SimpleNamespace
  for case in ['good','wrong-hash','changed-original','foreign-hardlink','duplicate-row']:
   with self.subTest(case=case),tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d,patch.object(db.sys,'base_prefix',d+'/base'),patch.object(db.support,'private_root',return_value=Path(d)):
    root=Path(d);source=root/'base/lib/libpython3.11.dylib';source.parent.mkdir(parents=True);source.write_bytes(b'inert CPython code fixture');os.link(source,source.with_name('existing-alias'))
    output=root/'build-output-001';output.mkdir();rows=[('libpython3.11.dylib',str(source),'BINARY')];analysis=SimpleNamespace(binaries=rows,datas=[])
    expected={'path':str(source),'identity':db.wb.read_checked(source)[0],'stat':list(db.wb.stamp(source.lstat()))+[2]}
    if case=='wrong-hash':expected['identity']=dict(expected['identity'],sha256='f'*64)
    if case=='changed-original':source.write_bytes(b'changed original')
    if case=='foreign-hardlink':
     foreign=root/'foreign.dylib';foreign.write_bytes(b'foreign');os.link(foreign,root/'foreign-alias');rows.append(('foreign.dylib',str(foreign),'BINARY'))
    if case=='duplicate-row':rows.append(rows[0])
    if case!='good':
     with self.assertRaises(ValueError):db.materialize_existing_python_library(analysis,output,expected)
     self.assertFalse((output/'owned-python-inputs').exists());continue
    proof=db.materialize_existing_python_library(analysis,output,expected);copy=Path(analysis.binaries[0][1]);self.assertEqual(copy.read_bytes(),source.read_bytes());self.assertEqual(copy.lstat().st_nlink,1);self.assertEqual(source.lstat().st_nlink,2);self.assertEqual(proof['originalIdentity'],expected['identity']);self.assertEqual(analysis.binaries[0][0],'libpython3.11.dylib')
 def test_install_name_tool_exact_pin_and_owned_output_grammar(self):
  tool={'path':'/usr/bin/install_name_tool',**db.wb.read_checked(Path('/usr/bin/install_name_tool'))[0]};gate={'existingToolchain':{'appleTools':{'/usr/bin/install_name_tool':tool}}}
  self.assertEqual(db.verify_install_name_tool(gate),tool)
  tool['sha256']='f'*64
  with self.assertRaisesRegex(ValueError,'TOOL_DRIFT'):db.verify_install_name_tool(gate)
  with patch.dict(os.environ,{'R55_BUILD_GUARD':'0'}):guard=load('r55_install_name_guard','r55_build_guard.py')
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d,patch.dict(os.environ,{'R55_CANONICAL_PRIVATE':d}):
   root=Path(d)/'build-output-001';root.mkdir();target=root/'library.dylib';target.write_bytes(b'owned native fixture');foreign=Path(d)/'foreign.dylib';foreign.write_bytes(b'foreign')
   good=['install_name_tool','-id','@rpath/library.dylib','-change','/original/library.dylib','@rpath/library.dylib','-delete_rpath','@loader_path/','-add_rpath','@loader_path/../..',str(target)]
   guard.install_name_arguments(good,str(root))
   for bad in [good[:-1]+[str(foreign)],['install_name_tool','-unknown','x',str(target)],['install_name_tool','-id','--bad',str(target)],['install_name_tool','-add_rpath','/tmp',str(target)],good[:-1]+['extra',str(target)]]:
    with self.subTest(argv=bad),self.assertRaises(RuntimeError):guard.install_name_arguments(bad,str(root))
   os.link(target,root/'alias.dylib')
   with self.assertRaisesRegex(RuntimeError,'OUTPUT_SCOPE'):guard.install_name_arguments(good,str(root))
 def test_selected_ort_range_hash_and_model_crossing_twins(self):
  import struct,zlib
  ort=load('r55_ort_test','darwin_ort.py');source=db.load_lock()['onnxruntimeCodeSource']
  self.assertTrue(ort.validate_source(source))
  bad=json.loads(json.dumps(source));bad['excludedD2Members'][0]['headerOffset']=bad['ranges'][0]['start']
  with self.assertRaisesRegex(ValueError,'CROSSES_MODEL'):ort.validate_source(bad)
  raw=b'original immutable code';name=b'onnxruntime/fixture.py';compress=zlib.compressobj(wbits=-15);compressed=compress.compress(raw)+compress.flush();crc=zlib.crc32(raw)
  header=struct.pack('<4s5H3I2H',b'PK\x03\x04',20,0,8,0,0,crc,len(compressed),len(raw),len(name),0)
  fragment=header+name+compressed;member={'path':name.decode(),'headerOffset':0,'compression':8,'crc32':crc,'compressedBytes':len(compressed),'bytes':len(raw),'sha256':ident(raw)['sha256'],'spanBytes':len(fragment)}
  self.assertEqual(ort.decode_member(fragment,member,0),raw)
  with self.assertRaisesRegex(ValueError,'RECORD_BOUND_BYTES'):ort.decode_member(fragment,dict(member,sha256='c'*64),0)
  with self.assertRaisesRegex(ValueError,'UNKNOWN_SPAN'):ort.decode_member(fragment+b'x',dict(member,spanBytes=len(fragment)+1),0)
 def test_exact_install_write_exception_does_not_admit_model_reads_or_foreign_writes(self):
  from types import SimpleNamespace
  with patch.dict(os.environ,{'R55_BUILD_GUARD':'0'}):guard=load('r55_guard_install','r55_build_guard.py')
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d,patch.object(guard.sys,'prefix',d),patch.object(guard.sys,'flags',SimpleNamespace(isolated=1)),patch.object(guard.sysconfig,'get_path',return_value=d+'/site'),patch.dict(os.environ,{'R55_BUILD_OUTPUT':''}):
   with self.assertRaisesRegex(RuntimeError,'PHYSICAL_SCOPE'):guard.admit_install_writes({d+'/site/../escape.npz'})
   file=d+'/site/approved-unit-test.npz';guard.admit_install_writes({file});guard.audit('open',(file,'wb',os.O_WRONLY))
   for mode in ('r+','w+',None):
    with self.subTest(mode=mode),self.assertRaisesRegex(RuntimeError,'D2_READ'):guard.audit('open',(file,mode,os.O_RDWR))
   with self.assertRaisesRegex(RuntimeError,'D2_READ'):guard.audit('open',(file,'r',os.O_RDONLY))
   with self.assertRaisesRegex(RuntimeError,'D2_READ'):guard.audit('open',(d+'/site/unknown-model.npz','w',os.O_WRONLY))
   with self.assertRaisesRegex(RuntimeError,'WRITE_AUTHORITY'):guard.admit_install_writes({file})
 def test_ort_partial_receive_is_sticky_and_encoded_headers_reject_before_body(self):
  from types import SimpleNamespace
  ort=load('r55_ort_receive','darwin_ort.py')
  source={'originalRecordSha256':ident(b'original RECORD')['sha256'],'originalWheel':{'url':'https://files.pythonhosted.org/approved.whl','bytes':100},'ranges':[{'start':10,'end':14,'members':[]}]}
  class Response:
   status=206
   def __init__(self,encoded=False):self.headers={'Content-Range':'bytes 10-14/100','Content-Length':'5','Content-Encoding':'gzip' if encoded else 'identity'};self.reads=0
   def geturl(self):return source['originalWheel']['url']
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self,n):
    self.reads+=1
    if self.reads==1:return b'abc'
    raise OSError('interrupted transfer')
  for encoded in (False,True):
   with self.subTest(encoded=encoded),tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d:
    root=Path(d);(root/'ort-original-RECORD.csv').write_bytes(b'original RECORD');response=Response(encoded)
    with patch.object(ort,'validate_source',return_value=True),patch.object(ort.urllib.request,'build_opener',return_value=SimpleNamespace(open=lambda *args,**kwargs:response)):
     with self.assertRaises((OSError,ValueError)):ort.acquire(source,root)
    receipt=json.loads((root/'ort-range-001-result.json').read_text())
    self.assertEqual(receipt['status'],'FAIL');self.assertTrue((root/'ort-range-001-claim.json').exists());self.assertEqual(receipt['retries'],0)
    self.assertEqual(receipt['actualReceivedBytes'],0 if encoded else 3);self.assertEqual(receipt['retainedBytes'],0 if encoded else 3)
    self.assertEqual(receipt['retainedSha256'],ident(b'' if encoded else b'abc')['sha256']);self.assertEqual(response.reads,0 if encoded else 2)
 def test_pure_d1_inventory_hash_grant_does_not_return_array_bytes(self):
  with patch.dict(os.environ,{'R55_BUILD_GUARD':'0'}):guard=load('r55_inventory_guard','r55_build_guard.py')
  with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as d,patch.object(guard.sysconfig,'get_path',return_value=d):
   p=Path(d)/'numpy/tests/approved.npz';p.parent.mkdir(parents=True);raw=b'opaque numerical test fixture';p.write_bytes(raw);p.with_name('unknown.npz').write_bytes(raw)
   hook=guard.audit;sys.addaudithook(hook)
   try:
    with self.assertRaisesRegex(RuntimeError,'D2_READ'):db.wb.read_checked(p)
    with guard.inventory_hashes({str(p)},db.wb.read_checked):
     self.assertEqual(db.wb.read_checked(p),(ident(raw),b''))
     with self.assertRaisesRegex(RuntimeError,'D2_READ'):db.wb.read_checked(p,collect=True)
     with self.assertRaisesRegex(RuntimeError,'D2_READ'):p.read_bytes()
     with self.assertRaisesRegex(RuntimeError,'D2_READ'):db.wb.read_checked(p.with_name('unknown.npz'))
    with self.assertRaisesRegex(RuntimeError,'D2_READ'):db.wb.read_checked(p)
   finally:
    # This one-off hook belongs only to the inert unit-test interpreter.
    # CPython has no removeaudithook; deactivate this fresh in-memory function.
    hook.__code__=(lambda event,args:None).__code__
if __name__=='__main__':unittest.main()
