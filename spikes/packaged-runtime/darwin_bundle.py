"""Darwin CPython 3.11 offline engineering admission and source-to-binary receipt.

Uses the existing safe ZIP/path/tree validator; no production manifest/roots.
"""
from __future__ import annotations
import ast
import base64
import csv
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import stat
import struct
import subprocess
import sys
import sysconfig
import time
import zipfile

ROOT=Path(__file__).resolve().parents[2]
def adjacent(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
wb=adjacent('r55_windows_validator',Path(__file__).with_name('windows_bundle.py'))
support=adjacent('r55_support',ROOT/'scripts/r55_support.py')
LOCK=Path(__file__).with_name('requirements-darwin-arm64-cp311.lock.json')
EXCLUDES=['native','voice_runtime.backends.fake','voice_runtime.backends.kokoro_python',
 'voice_runtime.backends.faster_whisper','kokoro','kokoro_onnx','misaki','faster_whisper',
 'espeakng_loader','phonemizer','soundfile','av','ctranslate2','torch','torchaudio',
 'mlx_whisper.cli','mlx_whisper.writers','mlx_whisper.torch_whisper','r55_build_guard','r55_tool_custody',
 'language_data','langcodes.data_dicts','langcodes.build_data','spacy.tests','scipy.tests','numpy.tests','PyInstaller','_pyinstaller_hooks_contrib']
HIDDEN=['voice_runtime.backends.mlx_whisper','voice_runtime.backends.kokoro_onnx',
 'voice_runtime.english_g2p','voice_runtime.english_numbers','voice_runtime.onnx_engine',
 'mlx_whisper','mlx.core','mlx.nn','mlx.utils','onnxruntime',
 'voice_practice_speech_vendor.kokoro_onnx','voice_practice_speech_vendor.kokoro_onnx.session',
 'voice_practice_speech_vendor.misaki.en','spacy.lang.en','spacy.pipeline','inflect','addict','regex','tiktoken_ext.openai_public']

def identity(path):
    if Path(path).lstat().st_nlink!=1:raise ValueError('DARWIN_HARDLINK')
    return wb.read_checked(path)[0]
def load_lock(path=LOCK):
    lock=wb.json_file(path)
    if lock.get('target')!={'platform':'darwin','arch':'arm64','python':'3.11','abi':'cp311'}:raise ValueError('DARWIN_LOCK_TARGET')
    names=set()
    for w in lock['wheels']:
        if w['name'] in names or w['role']!='D1_CODE_RUNTIME' or not wb.sha_valid(w['sha256']) or not 0<w['bytes']<=4*1024**3:
            raise ValueError('DARWIN_LOCK_ARTIFACT')
        names.add(w['name'])
        if not w['url'].startswith('https://files.pythonhosted.org/') or not w['filename'].endswith('.whl'):
            raise ValueError('DARWIN_LOCK_SOURCE')
        if not (w['licenseExpression'] or w['licenseDeclaration'] or w['licenseClassifiers']):raise ValueError('DARWIN_LICENSE_UNKNOWN')
    if 'langcodes' in names or 'mlx-whisper' in names or len(names)>256:raise ValueError('DARWIN_D2_MIXED_WHEEL')
    if names|{'langcodes','onnxruntime'}!=set(lock['constraints']):raise ValueError('DARWIN_MISSING_TRANSITIVE')
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.specifiers import SpecifierSet
    from pip._vendor.packaging.version import Version
    versions={w['name']:w['version'] for w in lock['wheels']}|{'langcodes':'3.3.0+codeonly.r55','onnxruntime':lock['onnxruntimeCodeSource']['version']}
    adjacent('r55_ort',Path(__file__).with_name('darwin_ort.py')).validate_source(lock['onnxruntimeCodeSource'])
    env={'platform_system':'Darwin','sys_platform':'darwin','platform_machine':'arm64','python_version':'3.11','python_full_version':'3.11.15','extra':''}
    for name,requirements in lock['constraints'].items():
        if any(Version(versions[name]) not in SpecifierSet(s) for s in requirements):raise ValueError('DARWIN_TRANSITIVE_VERSION')
    for w in [*lock['wheels'],lock['onnxruntimeCodeSource']['originalWheel']]:
        if w['requiresPython'] and Version('3.11.15') not in SpecifierSet(w['requiresPython']):raise ValueError('DARWIN_PYTHON_CONSTRAINT')
        for r in w['requiresDist']:
            req=Requirement(r)
            if req.marker and not any(req.marker.evaluate(dict(env,extra=x)) for x in ['',*w['extras']]):continue
            n=wb.normalize(req.name)
            if n not in versions or Version(versions[n]) not in req.specifier:raise ValueError('DARWIN_TRANSITIVE_CLOSURE')
    for name in ['mlx','mlx-metal','numpy','onnxruntime','spacy','inflect','numba','pyinstaller','pyinstaller-hooks-contrib']:
        if name not in names|{'onnxruntime'}:raise ValueError('DARWIN_MISSING_TRANSITIVE')
    return lock

def compatible(tags):
    for tag in tags:
        p,a,t=tag.split('-')
        if t=='any' and p in ('py3','py311') and a=='none':return True
        match=re.fullmatch(r'macosx_(\d+)_(\d+)_(arm64|universal2)',t)
        if match and int(match[1])<=int(platform.mac_ver()[0].split('.')[0]):
            if p=='cp311' and a in ('cp311','none'):return True
            if re.fullmatch(r'cp3\d+',p) and a=='abi3' and int(p[3:])<=11:return True
            if p=='py3' and a=='none':return True
    return False

def wheel_inventory(path,expected):
    from email.parser import BytesParser
    if identity(path)!={'bytes':expected['bytes'],'sha256':expected['sha256']} or Path(path).name!=expected['filename']:
        raise ValueError('DARWIN_WHEEL_HASH')
    files=wb.zip_inventory(path)
    from pip._vendor.packaging.utils import parse_wheel_filename
    name,version,_,filename_tags=parse_wheel_filename(Path(path).name)
    if wb.normalize(name)!=expected['name'] or str(version)!=expected['version'] or set(map(str,filename_tags))!=set(expected['tags']):
        raise ValueError('DARWIN_WHEEL_FILENAME_ABI')
    def build_tool_source(p):
        return expected['name']=='pyinstaller-hooks-contrib' and p=='_pyinstaller_hooks_contrib/utils/nvidia_cuda.py'
    if any(wb.forbidden_path(p) and not build_tool_source(p) and not p.startswith(('voice_practice_speech_vendor/','mlx_whisper/')) and not p.startswith('mlx_whisper-') for p in files):
        raise ValueError('DARWIN_FORBIDDEN_WHEEL')
    infos={p.split('/')[0] for p in files if p.split('/')[0].endswith('.dist-info')}
    if len(infos)!=1:raise ValueError('DARWIN_WHEEL_METADATA')
    dist=next(iter(infos))
    with zipfile.ZipFile(path) as z:
        raw_meta=z.read(dist+'/METADATA');meta=BytesParser().parsebytes(raw_meta)
        authority=expected.get('requiresDistAuthority')
        if authority and (authority['path']!=dist+'/METADATA' or {'bytes':len(raw_meta),'sha256':hashlib.sha256(raw_meta).hexdigest()}!={'bytes':authority['bytes'],'sha256':authority['sha256']}):raise ValueError('DARWIN_WHEEL_METADATA_AUTHORITY')
        tags=BytesParser().parsebytes(z.read(dist+'/WHEEL')).get_all('Tag',[])
        if wb.normalize(meta.get('Name',''))!=expected['name'] or meta.get('Version')!=expected['version'] or set(tags)!=set(expected['tags']) or not compatible(tags):
            raise ValueError('DARWIN_WHEEL_ABI_METADATA')
        from pip._vendor.packaging.requirements import Requirement
        if {str(Requirement(r)) for r in meta.get_all('Requires-Dist',[])}!={str(Requirement(r)) for r in expected.get('requiresDist',[])}:
            raise ValueError('DARWIN_WHEEL_DEPENDENCY_METADATA')
        rows=list(csv.reader(io.StringIO(z.read(dist+'/RECORD').decode())))
    seen=set()
    for row in rows:
        if len(row)!=3 or row[0] in seen or row[0] not in files:raise ValueError('DARWIN_RECORD')
        p,h,size=row;seen.add(p)
        if p==dist+'/RECORD':
            if h or size:raise ValueError('DARWIN_RECORD_SELF')
        elif h!='sha256='+base64.urlsafe_b64encode(bytes.fromhex(files[p]['sha256'])).rstrip(b'=').decode() or size!=str(files[p]['bytes']):
            raise ValueError('DARWIN_RECORD_HASH')
    if seen!=set(files):raise ValueError('DARWIN_RECORD_SET')
    return {'name':expected['name'],'version':expected['version'],'files':files,'identity':identity(path),'path':str(path)}

def inventory_scope(plan):
    from contextlib import nullcontext
    guard=sys.modules.get('r55_build_guard')
    if not guard or os.environ.get('R55_BUILD_GUARD')!='1':return nullcontext()
    site=Path(sysconfig.get_path('purelib')).absolute()
    files={str(wb.installed_destination(p,site)) for w in plan['wheels'].values() for p in w['files'] if p.endswith('.npz')}
    return guard.inventory_hashes(files,wb.read_checked)

def installed_tree(plan):
    with inventory_scope(plan):return wb.tree(Path(sysconfig.get_path('purelib')))

def venv_baseline(private):
    baseline_path=private/'venv-baseline.json'
    if (private/'venv-repair-001-result.json').exists():
        repair=wb.json_file(private/'venv-repair-001-result.json')
        baseline_path=private/'venv-baseline-repaired.json'
        if repair['closure']!='CLOSED' or repair['oldBaselineSha256']!=identity(private/'venv-baseline.json')['sha256'] or repair['newBaselineSha256']!=identity(baseline_path)['sha256'] or repair['claimSha256']!=identity(private/'venv-repair-001-claim.json')['sha256']:raise ValueError('DARWIN_VENV_REPAIR_BINDING')
    return wb.json_file(baseline_path)

def script_relocations(plan):
    # PEP 427 scripts receive only the reviewed pip #!python relocation. The
    # exact source wheel and rest of the script remain byte-bound; Windows'
    # original validator is unchanged and consumes this narrow Darwin view.
    normalized=dict(plan,wheels={});relocated={}
    site=Path(sysconfig.get_path('purelib'))
    for name,wheel in plan['wheels'].items():
        copied=dict(wheel,files=dict(wheel['files']));normalized['wheels'][name]=copied
        for member,item in wheel['files'].items():
            parts=member.split('/')
            if not (parts[0].endswith('.data') and len(parts)>2 and parts[1]=='scripts'):continue
            if (name,member)!=('numba','numba-0.61.2.data/scripts/numba'):raise ValueError('DARWIN_SCRIPT_RELOCATION_SCOPE')
            if identity(wheel['path'])!=wheel['identity']:raise ValueError('DARWIN_SCRIPT_WHEEL_DRIFT')
            with zipfile.ZipFile(wheel['path']) as archive:raw=archive.read(member)
            if {'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}!=item or not raw.startswith(b'#!python\n'):raise ValueError('DARWIN_SCRIPT_SOURCE_DRIFT')
            transformed=b'#!'+os.fsencode(sys.executable)+b'\n'+raw.split(b'\n',1)[1]
            expected={'bytes':len(transformed),'sha256':hashlib.sha256(transformed).hexdigest()}
            copied['files'][member]=expected
            destination=wb.installed_destination(member,site).absolute()
            relocated[str(destination)]={'distribution':name,'wheelMember':member,'sourceWheelSha256':wheel['identity']['sha256'],'original':item,'installedExpected':expected,'transformation':'PIP_EXACT_PEP427_SHEBANG_ONLY'}
    return normalized,relocated

def verify_installed(plan):
    with inventory_scope(plan):return _verify_installed(plan)

def _verify_installed(plan):
    # Existing full file/RECORD verifier also rejects stale bytecode and extras.
    normalized,relocated=script_relocations(plan)
    wb.verify_installed(normalized)
    verify_embedded_records(plan)
    # Independently verify rewritten installed RECORD, including console scripts
    # outside site-packages. No RECORD row can expand the install authority.
    import configparser
    from pip._internal.operations.install.wheel import PipScriptMaker
    from pip._vendor.distlib.util import get_export_entry
    site=Path(sysconfig.get_path('purelib')).absolute()
    scripts=Path(sysconfig.get_path('scripts')).absolute()
    allowed_scripts={Path(p):x['installedExpected'] for p,x in relocated.items()}; script_owners={Path(p):x['distribution'] for p,x in relocated.items()}; expected_paths={}; record_paths=set()
    for name,wheel in plan['wheels'].items():
        info=next(p.split('/')[0] for p in wheel['files'] if p.endswith('.dist-info/METADATA'))
        expected={wb.installed_destination(p,site).absolute() for p in wheel['files']}
        entry_file=site/info/'entry_points.txt'
        if entry_file.exists():
            parser=configparser.ConfigParser(interpolation=None);parser.optionxform=str
            parser.read_string(entry_file.read_text())
            maker=PipScriptMaker(None,str(scripts));maker.executable=sys.executable
            for section in ('console_scripts','gui_scripts'):
                if not parser.has_section(section):continue
                for label,target in parser.items(section):
                    if not re.fullmatch(r'[A-Za-z0-9_.-]+',label):raise ValueError('DARWIN_CONSOLE_NAME')
                    entry=get_export_entry(label+' = '+target)
                    text=maker._get_script_text(entry).encode('utf-8')
                    body=maker._get_shebang('utf-8')+text
                    labels=[label]
                    if name=='pip' and label=='pip':labels=['pip','pip3','pip3.11']
                    for label2 in labels:
                        destination=scripts/label2
                        if not destination.exists():raise ValueError('DARWIN_CONSOLE_SCRIPT_MISSING')
                        if destination.exists():
                            if wb.read_checked(destination,collect=True)[1]!=body:raise ValueError('DARWIN_CONSOLE_SCRIPT_BYTES')
                            if destination in allowed_scripts and script_owners[destination]!=name:raise ValueError('DARWIN_CONSOLE_COLLISION')
                            script_owners[destination]=name
                            allowed_scripts[destination]=identity(destination);expected.add(destination)
        for extra in ('INSTALLER','REQUESTED','direct_url.json','uv_cache.json'):
            if (site/info/extra).exists():expected.add(site/info/extra)
        record=site/info/'RECORD';record_paths.add(record)
        rows=list(csv.reader(io.StringIO(wb.read_checked(record,collect=True)[1].decode())))
        seen=set()
        for row in rows:
            if len(row)!=3 or '\\' in row[0] or Path(row[0]).is_absolute():raise ValueError('DARWIN_INSTALLED_RECORD')
            destination=Path(os.path.abspath(site/row[0]))
            if destination in seen or destination not in expected:raise ValueError('DARWIN_INSTALLED_RECORD_SCOPE')
            seen.add(destination)
            if destination==record:
                if row[1:]!=['','']:raise ValueError('DARWIN_INSTALLED_RECORD_SELF')
                continue
            item=identity(destination)
            wanted='sha256='+base64.urlsafe_b64encode(bytes.fromhex(item['sha256'])).rstrip(b'=').decode()
            if row[1]!=wanted or row[2]!=str(item['bytes']):raise ValueError('DARWIN_INSTALLED_RECORD_HASH')
        if seen!=expected:raise ValueError('DARWIN_INSTALLED_RECORD_SET')
        expected_paths[name]=sorted(str(x) for x in expected)
    private=support.private_root(ROOT)
    baseline=venv_baseline(private)
    current=wb.tree(scripts)
    expected_bin=dict(baseline['bin'])
    expected_bin.update({p.name:item for p,item in allowed_scripts.items()})
    if current!=expected_bin:raise ValueError('DARWIN_VENV_BIN_DRIFT')
    if identity(Path(sys.prefix)/'pyvenv.cfg')!=baseline['config']:raise ValueError('DARWIN_VENV_CONFIG_DRIFT')
    startup={}
    for name,wheel in plan['wheels'].items():
        for p,item in wheel['files'].items():
            if p.endswith('.pth'):
                colored=name=='coloredlogs' and p=='coloredlogs.pth' and item=={'bytes':147,'sha256':'dda83a855986efa5cd87f0248b0199c0086eb0e8e7fece7d6741959c5ce39536'} and os.environ.get('COLOREDLOGS_AUTO_INSTALL')==''
                if not colored and (name,p) not in (('setuptools','distutils-precedence.pth'),('r55-build-guard','00_r55_build_guard.pth')):
                    raise ValueError('DARWIN_UNAPPROVED_PTH')
                startup[p]=item
    return startup

def verify_embedded_records(plan):
    site=Path(sysconfig.get_path('purelib'))
    for wheel in plan['wheels'].values():
        top=next(p.split('/')[0] for p in wheel['files'] if p.endswith('.dist-info/METADATA') and len(p.split('/'))==2)+'/RECORD'
        for member,item in wheel['files'].items():
            if member.endswith('.dist-info/RECORD') and member!=top:
                if identity(wb.installed_destination(member,site))!=item:raise ValueError('DARWIN_EMBEDDED_RECORD_DRIFT')

def require_native():
    if platform.system()!='Darwin' or platform.machine()!='arm64' or sys.version_info[:2]!=(3,11) or sys.prefix==sys.base_prefix:
        raise ValueError('DARWIN_ISOLATED_CP311_REQUIRED')
    if os.environ.get('PYTHONPATH') or os.environ.get('PYTHONHOME') or sys.flags.isolated!=1:raise ValueError('DARWIN_ENV_CONTAMINATION')
    if os.environ.get('R55_BUILD_GUARD')!='1':raise ValueError('DARWIN_BUILD_GUARD_REQUIRED')
    if os.environ.get('COLOREDLOGS_AUTO_INSTALL')!='':raise ValueError('DARWIN_STARTUP_ENV_REQUIRED')

def reviewed_source():
    private=support.private_root(ROOT)
    code=subprocess.check_output(['/usr/bin/git','rev-parse','HEAD'],cwd=ROOT).decode().strip()
    gate=wb.json_file(private/('source-admission-'+code+'.json'))
    if gate.get('decision')!='PASS' or gate['code']!=code or gate['lockSha256']!=identity(LOCK)['sha256']:
        raise ValueError('DARWIN_SOURCE_REVIEW_REQUIRED')
    for p,h in gate['sourceFiles'].items():
        wb.safe_relative(p)
        if identity(ROOT/p)['sha256']!=h:raise ValueError('DARWIN_REVIEWED_SOURCE_DRIFT')
    return code,gate

def plan(wheelhouse,installation,mode='engineering'):
    if mode!='engineering':raise ValueError('DARWIN_PRODUCTION_RESOURCES_INCOMPLETE')
    lock=load_lock();wheelhouse=wb.physical(wheelhouse,True)
    doc=wb.json_file(installation,64*1024**2)
    if doc['lockSha256']!=identity(LOCK)['sha256']:raise ValueError('DARWIN_INSTALLED_LOCK_DRIFT')
    entries=[*lock['wheels'],*doc['localWheels']]
    expected={e['filename'] for e in entries}|{lock['kokoroSource']['filename']}
    if set(wb.tree(wheelhouse))!=expected:raise ValueError('DARWIN_WHEELHOUSE_CLOSURE')
    wheels={}
    for e in entries:
        if e['name'] in wheels:raise ValueError('DARWIN_DUPLICATE_DISTRIBUTION')
        wheels[e['name']]=wheel_inventory(wheelhouse/e['filename'],e)
    result={'wheels':wheels,'hiddenimports':HIDDEN,'excludes':EXCLUDES,'datas':[],
            'outputClass':'ENGINEERING_CODE_ONLY_NOT_ACTIVATABLE','d2Gaps':lock['d2Gaps']}
    verify_installed(result)
    site=Path(sysconfig.get_path('purelib'))
    # Data/code licenses selected by actual packages, never old eSpeak trees.
    for name,w in wheels.items():
        for member in w['files']:
            if member.endswith('.pth') or member in ('r55_build_guard.py','r55_tool_custody.py'):continue
            is_notice=('.dist-info/' in member and (member.endswith(('METADATA','WHEEL')) or '/licenses/' in member)) or Path(member).name.upper().startswith(('LICENSE','COPYING','NOTICE','THIRDPARTYNOTICES'))
            is_vendor=member.startswith('voice_practice_speech_vendor/') and not member.endswith('.py')
            is_metal=member.startswith('mlx/') and member.endswith(('.metallib','.dylib'))
            if is_notice or is_vendor or is_metal:result['datas'].append((str(site/member),str(Path(member).parent)))
    result['lockSha256']=identity(LOCK)['sha256'];result['installationSha256']=identity(installation)['sha256']
    return result

def materialize_existing_python_library(analysis,output,expected):
    source=Path(sys.base_prefix)/'lib/libpython3.11.dylib'
    if not expected or expected['path']!=str(source):raise ValueError('DARWIN_PYTHON_LIBRARY_AUTHORITY')
    rows=[(i,row) for i,row in enumerate(analysis.binaries) if row[0]=='libpython3.11.dylib' or row[1]==str(source)]
    if len(rows)!=1 or rows[0][1]!=('libpython3.11.dylib',str(source),'BINARY'):raise ValueError('DARWIN_PYTHON_LIBRARY_ROW')
    before=wb.physical(source).lstat()
    if list(wb.stamp(before))+[before.st_nlink]!=expected['stat'] or before.st_nlink!=2:raise ValueError('DARWIN_PYTHON_LIBRARY_ORIGINAL_DRIFT')
    for _,path,kind in [*analysis.binaries,*analysis.datas]:
        if kind!='SYMLINK' and path!=str(source) and Path(path).lstat().st_nlink!=1:raise ValueError('DARWIN_FOREIGN_HARDLINK')
    item,raw=wb.read_checked(source,64*1024**2,collect=True)
    if item!=expected['identity'] or list(wb.stamp(source.lstat()))+[source.lstat().st_nlink]!=expected['stat']:raise ValueError('DARWIN_PYTHON_LIBRARY_ORIGINAL_DRIFT')
    output=wb.physical(output,True)
    if output.parent!=support.private_root(ROOT) or not re.fullmatch(r'build-output-[0-9]{3}',output.name):raise ValueError('DARWIN_PYTHON_LIBRARY_OUTPUT_SCOPE')
    folder=output/'owned-python-inputs';folder.mkdir(mode=0o700)
    copy=folder/source.name;support.write_new(copy,raw);os.chmod(copy,stat.S_IMODE(before.st_mode))
    if identity(copy)!=item:raise ValueError('DARWIN_PYTHON_LIBRARY_COPY_DRIFT')
    analysis.binaries[rows[0][0]]=(source.name,str(copy),'BINARY')
    return {'originalSource':str(source),'originalStat':expected['stat'],'originalIdentity':item,'originalMode':stat.S_IMODE(before.st_mode),'ownedCopy':str(copy),'ownedCopyIdentity':identity(copy),'ownedCopyNlink':copy.lstat().st_nlink,'originalPreserved':True}

def validate_collection(analysis,plan,output=None,existing_python=None):
    library=materialize_existing_python_library(analysis,output,existing_python)
    aliases=[]; allrows={n:(p,k) for n,p,k in [*analysis.binaries,*analysis.datas]}
    for rows in (analysis.binaries,analysis.datas):
        for i,(n,p,k) in enumerate(rows):
            wb.safe_relative(n)
            if k=='SYMLINK':
                import posixpath
                target=posixpath.normpath(posixpath.join(posixpath.dirname(n),p))
                if target not in allrows or allrows[target][1]=='SYMLINK':raise ValueError('DARWIN_UNRESOLVED_LOADER_ALIAS')
                original,kind=allrows[target];wb.physical(original)
                rows[i]=(n,original,kind)
                aliases.append({'path':n,'target':target,'source':identity(original)})
            if wb.forbidden_path(n) and not n.startswith('voice_practice_speech_vendor/') and not n.startswith('mlx/'):
                raise ValueError('DARWIN_FORBIDDEN_COLLECTION')
    for n,p,k in analysis.pure:
        if n in EXCLUDES or n.startswith(('kokoro.','faster_whisper.','espeakng_loader.','voice_runtime.backends.fake')):
            raise ValueError('DARWIN_FORBIDDEN_MODULE')
    expected={str(Path(dest)/Path(src).name):identity(src) for src,dest in plan['datas']}
    collected={n:identity(p) for n,p,k in [*analysis.datas,*analysis.binaries] if n in expected}
    if collected!=expected:raise ValueError('DARWIN_RESOURCE_COLLECTION_DRIFT')
    modules=set(n for n,*_ in analysis.pure)
    modules.update('.'.join(Path(n).parts[:-1]+(Path(n).name.split('.')[0],)) for n,p,k in analysis.binaries if k=='EXTENSION')
    sources={}
    for n,p,k in analysis.pure:
        if p in (None,'-'):
            members=sorted(m for m in modules if m.startswith(n+'.'))
            if not members:raise ValueError('DARWIN_NAMESPACE_CLOSURE')
            sources[n]={'kind':'PEP420_NAMESPACE','members':members}
        else:sources[n]={'source':str(p),'identity':identity(p)}
    return {'existingPythonLibraryMaterialization':library,'aliasesMaterializedAtCollection':aliases,'pythonModules':sorted(modules),
            'requiredCode':['voice_runtime.server',*HIDDEN],'dataInputs':expected,
            'startupScripts':[{'module':n,'source':str(p),'kind':k,'identity':identity(p)} for n,p,k in analysis.scripts],
            'pythonSourceInputs':sources,
            'sourceToCollected':{n:{'source':str(p),'kind':k,'identity':identity(p)} for n,p,k in [*analysis.binaries,*analysis.datas]}}

def macho_arches(path):
    with open(path,'rb') as f:b=f.read(4096)
    if len(b)<8:return None
    magic=b[:4]
    if magic in (b'\xcf\xfa\xed\xfe',b'\xce\xfa\xed\xfe'):return [struct.unpack('<I',b[4:8])[0]]
    if magic in (b'\xfe\xed\xfa\xcf',b'\xfe\xed\xfa\xce'):return [struct.unpack('>I',b[4:8])[0]]
    if magic in (b'\xca\xfe\xba\xbe',b'\xca\xfe\xba\xbf'):
        count=struct.unpack('>I',b[4:8])[0];stride=32 if magic[-1]==0xbf else 20
        if count>16 or len(b)<8+count*stride:raise ValueError('DARWIN_FAT_ABI')
        return [struct.unpack('>I',b[8+i*stride:12+i*stride])[0] for i in range(count)]
    return None

def macho_abi(path):
    """Static arm64 load commands, based on the existing SDK mach-o/loader.h.

    This inventories dyld inputs; it does not qualify runtime reader lifetime.
    """
    raw=wb.read_checked(path,collect=True)[1];offset=0;limit=len(raw)
    if raw[:4] in (b'\xca\xfe\xba\xbe',b'\xca\xfe\xba\xbf'):
        stride=32 if raw[3]==0xbf else 20;count=struct.unpack_from('>I',raw,4)[0]
        if count>16 or len(raw)<8+count*stride:raise ValueError('DARWIN_FAT_ABI')
        found=[]
        for i in range(count):
            row=8+i*stride;cpu=struct.unpack_from('>I',raw,row)[0]
            begin,size=struct.unpack_from('>QQ' if stride==32 else '>II',raw,row+8)
            if cpu==0x0100000c:found.append((begin,size))
        if len(found)!=1:raise ValueError('DARWIN_ARM64_SLICE')
        offset,size=found[0];limit=offset+size
    if limit>len(raw) or offset+32>limit or raw[offset:offset+4]!=b'\xcf\xfa\xed\xfe':raise ValueError('DARWIN_ARM64_HEADER')
    header=struct.unpack_from('<8I',raw,offset)
    if header[1]!=0x0100000c or header[4]>65536 or offset+32+header[5]>limit:raise ValueError('DARWIN_LOAD_COMMAND_BOUND')
    cursor=offset+32;end=cursor+header[5];commands=[];deps=[];rpaths=[];versions=[];ids=[]
    def version(v):return f'{v>>16}.{(v>>8)&255}.{v&255}'
    for _ in range(header[4]):
        if cursor+8>end:raise ValueError('DARWIN_LOAD_COMMAND_BOUND')
        cmd,size=struct.unpack_from('<II',raw,cursor)
        if size<8 or size%4 or cursor+size>end:raise ValueError('DARWIN_LOAD_COMMAND_BOUND')
        block=raw[cursor:cursor+size];item={'command':cmd,'bytes':size,'sha256':hashlib.sha256(block).hexdigest()}
        def name(minimum):
            if size<minimum:raise ValueError('DARWIN_LOAD_COMMAND_FIELDS')
            at=struct.unpack_from('<I',block,8)[0]
            if at<minimum or at>=size or b'\0' not in block[at:]:raise ValueError('DARWIN_LOAD_COMMAND_STRING')
            return block[at:].split(b'\0',1)[0].decode('utf-8')
        if cmd in (0xc,0xd,0x80000018,0x8000001f,0x20,0x80000023):
            item.update({'name':name(24),'currentVersion':version(struct.unpack_from('<I',block,16)[0]),'compatibilityVersion':version(struct.unpack_from('<I',block,20)[0])})
            (ids if cmd==0xd else deps).append(item)
        elif cmd==0x8000001c:item['path']=name(12);rpaths.append(item['path'])
        elif cmd==0x32:
            if size<24:raise ValueError('DARWIN_BUILD_VERSION_BOUND')
            platform_id,minos,sdk,ntools=struct.unpack_from('<4I',block,8)
            if size!=24+ntools*8:raise ValueError('DARWIN_BUILD_VERSION_BOUND')
            item.update(platform=platform_id,minimumOS=version(minos),sdk=version(sdk),tools=[{'tool':struct.unpack_from('<I',block,24+i*8)[0],'version':version(struct.unpack_from('<I',block,28+i*8)[0])}for i in range(ntools)])
            versions.append(item)
        elif cmd==0x24:
            if size!=16:raise ValueError('DARWIN_BUILD_VERSION_BOUND')
            item.update(platform=1,minimumOS=version(struct.unpack_from('<I',block,8)[0]),sdk=version(struct.unpack_from('<I',block,12)[0]));versions.append(item)
        elif cmd==0x1b:
            if size!=24:raise ValueError('DARWIN_UUID_BOUND')
            item['uuid']=block[8:].hex()
        commands.append(item);cursor+=size
    if cursor!=end:raise ValueError('DARWIN_LOAD_COMMAND_CLOSURE')
    return {'sliceOffset':offset,'sliceBytes':limit-offset,'cpuType':header[1],'cpuSubtype':header[2],'fileType':header[3],'flags':header[6],'loadCommands':commands,'dependencies':deps,'installNames':ids,'rpaths':rpaths,'buildVersions':versions,'scope':'STATIC_ARM64_LOAD_COMMANDS_ONLY','runtimeReaderQualification':False}

def post_build(runtime,plan):
    files=wb.tree(runtime);abi={};modes={}
    if 'bin/voice-runtime' not in files:raise ValueError('DARWIN_ENTRYPOINT_MISSING')
    for p in files:
        if wb.forbidden_path(p.removeprefix('bin/_internal/')) and not '/voice_practice_speech_vendor/' in p and not '/mlx/' in p:raise ValueError('DARWIN_FORBIDDEN_OUTPUT')
        arches=macho_arches(runtime/p)
        if arches is not None:
            if arches!=[0x0100000c]:raise ValueError('DARWIN_WRONG_MACHO_ABI')
            abi[p]={'cpuTypes':arches,'sha256':files[p]['sha256'],'arm64':macho_abi(runtime/p)}
        modes[p]=stat.S_IMODE((runtime/p).stat().st_mode)
    if 'bin/voice-runtime' not in abi or not os.access(runtime/'bin/voice-runtime',os.X_OK):raise ValueError('DARWIN_EXECUTABLE_ABI')
    for src,dest in plan['datas']:
        p='bin/_internal/'+str(Path(dest)/Path(src).name)
        if p not in files or (p not in abi and files[p]!=identity(src)):
            raise ValueError('DARWIN_POST_BUILD_DATA_DRIFT')
    # Account for every static linkage. Unknown dyld resolution is recorded as
    # unproved, never interpreted as closed reader or managed qualification.
    linkage=[]
    def expand(value,loader):
        if value.startswith('@loader_path'):return os.path.normpath(str(runtime/Path(loader).parent)+value[len('@loader_path'):])
        if value.startswith('@executable_path'):return os.path.normpath(str(runtime/'bin')+value[len('@executable_path'):])
        return value
    runpaths=[expand(r,p) for p,a in abi.items() for r in a['arm64']['rpaths']]
    for p,a in abi.items():
        for dep in a['arm64']['dependencies']:
            name=dep['name'];item={'reader':p,'name':name,'command':dep['command'],'resolvedBundledPaths':[]}
            if name.startswith(('/usr/lib/','/System/Library/')):item['status']='SYSTEM_DYLD_SHARED_CACHE_LINK'
            elif name.startswith('/'):
                item['status']='FORBIDDEN_EXTERNAL_ABSOLUTE_LINK';raise ValueError('DARWIN_EXTERNAL_LINK '+p+' '+name)
            else:
                candidates=[expand(name,p)] if not name.startswith('@rpath/') else [os.path.normpath(r+'/'+name[len('@rpath/'):]) for r in runpaths if r.startswith('/')]
                for candidate in candidates:
                    try:relative=str(Path(candidate).relative_to(runtime))
                    except ValueError:continue
                    if relative in abi:item['resolvedBundledPaths'].append(relative)
                item['status']='BUNDLED_STATIC_CANDIDATE' if item['resolvedBundledPaths'] else 'UNRESOLVED_STATIC_LINK'
            linkage.append(item)
    lines=''.join(f"{p}:{v['bytes']}:{v['sha256']}\n" for p,v in sorted(files.items()))
    return {'outputClass':plan['outputClass'],'files':files,'modes':modes,'macho':abi,
            'treeDigest':hashlib.sha256(lines.encode()).hexdigest(),'staticLinkage':linkage,'staticLinkageUnresolved':[x for x in linkage if x['status']=='UNRESOLVED_STATIC_LINK'],'d2Gaps':plan['d2Gaps'],
            'productionResourcesComplete':False,'managedRuntimeQualified':False}

_epoch_deadline=None
_epoch_started=None

def prime_platform_metadata(private,gate):
    """Reuse actual CPython metadata, with no new child in the build owner."""
    receipt_path=private/'platform-preflight-001.json'
    if identity(receipt_path)['sha256']!=gate.get('platformPreflightSha256'):raise ValueError('DARWIN_PLATFORM_RECEIPT_BINDING')
    receipt=wb.json_file(receipt_path)
    expected_inputs={str(Path(sys.executable).resolve()),str(Path(platform.__file__).resolve()),'/usr/bin/uname','/usr/bin/file','/System/Library/CoreServices/SystemVersion.plist'}
    if set(receipt['inputs'])!=expected_inputs:raise ValueError('DARWIN_PLATFORM_INPUT_SET')
    if receipt['closure']!='CLOSED' or receipt['exit']!=0 or receipt['uname']!=list(os.uname()) or receipt['macVersion']!=json.loads(json.dumps(platform.mac_ver())):raise ValueError('DARWIN_PLATFORM_SNAPSHOT_DRIFT')
    for filename,item in receipt['inputs'].items():
        if identity(Path(filename))!=item:raise ValueError('DARWIN_PLATFORM_INPUT_DRIFT')
    if receipt['pythonExecutable']!=str(Path(sys.executable).resolve()) or receipt['platformSource']!=str(Path(platform.__file__).resolve()):raise ValueError('DARWIN_PLATFORM_INTERPRETER_DRIFT')
    if [t['argv'] for t in receipt['tools']]!=[['uname','-p'],['file','-b',str(Path(sys.executable).resolve())]]:raise ValueError('DARWIN_PLATFORM_TOOL_SCOPE')
    if [t['stdoutPath'] for t in receipt['tools']]!=['platform-preflight-001-uname.stdout','platform-preflight-001-file.stdout']:raise ValueError('DARWIN_PLATFORM_OUTPUT_SCOPE')
    for tool in receipt['tools']:
        raw=support.read_file(private/tool['stdoutPath'])
        if tool['exit']!=0 or not tool['reaped'] or not tool['bothDrained'] or tool['stdout']!={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}:raise ValueError('DARWIN_PLATFORM_TOOL_PROOF')
    processor=support.read_file(private/receipt['tools'][0]['stdoutPath']).decode('utf8').strip()
    expected_processor='' if processor=='unknown' else processor
    if receipt['processor']!=expected_processor or not receipt['platform']:raise ValueError('DARWIN_PLATFORM_OUTPUT_DRIFT')
    # These are CPython's existing caches, populated only with its own retained
    # results. No callable, interpreter, package or guard is replaced.
    platform.uname().__dict__['processor']=receipt['processor']
    platform._platform_cache[(0,0)]=receipt['platform']
    return receipt

def supervised_epoch(call):
    """One owner timer for gate/plan, packager, postchecks, receipts and cleanup."""
    global _epoch_deadline,_epoch_started
    if _epoch_deadline is not None:raise ValueError('DARWIN_NESTED_EPOCH')
    import r55_tool_custody
    _epoch_started=time.monotonic();_epoch_deadline=_epoch_started+3600
    remaining=max(0,_epoch_deadline-time.monotonic())
    try:return r55_tool_custody.supervise(call,remaining)
    finally:_epoch_deadline=None;_epoch_started=None

def build(wheelhouse,installation,output,mode):
    if _epoch_deadline is None:return supervised_epoch(lambda:_build(wheelhouse,installation,output,mode))
    return _build(wheelhouse,installation,output,mode)

def verify_install_name_tool(gate):
    tool=gate['existingToolchain']['appleTools']['/usr/bin/install_name_tool']
    # Existing Apple command shims themselves have system-owned hardlinks;
    # this exact OS executable is hashed through the stable fd reader only.
    if tool['path']!='/usr/bin/install_name_tool' or wb.read_checked(Path(tool['path']))[0]!={k:tool[k] for k in ('bytes','sha256')}:raise ValueError('DARWIN_EXISTING_INSTALL_NAME_TOOL_DRIFT')
    return tool

def packager_distpath(output):
    # COLLECT normalizes its name to a basename, so the runtime parent belongs
    # in PyInstaller's distpath rather than a slash-containing COLLECT name.
    return str(Path(output)/'dist/runtime')

def _build(wheelhouse,installation,output,mode):
    if _epoch_deadline is None:raise ValueError('DARWIN_EPOCH_OWNER_REQUIRED')
    require_native();code,gate=reviewed_source();before=plan(wheelhouse,installation,mode)
    verify_install_name_tool(gate)
    private=support.private_root(ROOT);output=Path(output).absolute();wb.physical(output.parent,True)
    if output.parent!=private or not re.fullmatch(r'build-output-[0-9]{3}',output.name):raise ValueError('DARWIN_PRIVATE_OUTPUT_REQUIRED')
    if output.exists():raise ValueError('DARWIN_OUTPUT_EXISTS')
    metadata=prime_platform_metadata(private,gate)
    os.environ['R55_CANONICAL_PRIVATE']=str(private)
    import r55_tool_custody
    claim=support.claim(private,'build',{'code':code,'lockSha256':before['lockSha256'],'installationSha256':before['installationSha256'],'specSha256':identity(Path(__file__).with_name('voice-runtime.spec'))['sha256'],'planSha256':hashlib.sha256(support.encoded(before)).hexdigest()})
    # PyInstaller runs inside the original owner. Every Popen in this owner and
    # its fixed isolated workers is registered by the reviewed startup guard.
    start=_epoch_started
    closure='UNKNOWN';exit_code=None
    try:
        output.mkdir(mode=0o700)
        args=['--darwin-wheelhouse',str(Path(wheelhouse).absolute()),'--darwin-installation',str(Path(installation).absolute()),'--darwin-mode',mode,'--darwin-output',str(output)]
        cmd=[sys.executable,'-I','-B','-m','PyInstaller','--distpath',packager_distpath(output),'--workpath',str(output/'work'),str(Path(__file__).with_name('voice-runtime.spec')),'--',*args]
        os.environ.update(COLOREDLOGS_AUTO_INSTALL='',PYTHONDONTWRITEBYTECODE='1',HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',R55_BUILD_GUARD='1',R55_BUILD_OUTPUT=str(output),PYINSTALLER_CONFIG_DIR=str(output/'packager-cache'),PATH='/usr/bin:/bin:/usr/sbin:/sbin')
        cache=output/'package-caches';cache.mkdir(mode=0o700)
        os.environ.update(HF_HOME=str(cache/'huggingface'),HF_HUB_CACHE=str(cache/'huggingface/hub'),XDG_CACHE_HOME=str(cache),NUMBA_CACHE_DIR=str(cache/'numba'),MPLCONFIGDIR=str(cache/'matplotlib'),PIP_CACHE_DIR=str(cache/'pip'))
        tools=output/'tool-receipts';tools.mkdir(mode=0o700);os.environ['R55_TOOL_RECEIPTS']=str(tools)
        from PyInstaller.__main__ import run
        run(cmd[5:])
        exit_code=0
        after=plan(wheelhouse,installation,mode)
        if after!=before or reviewed_source()[0]!=code:raise ValueError('DARWIN_BUILD_INPUT_DRIFT')
        runtime=output/'dist/runtime'
        support.write_new(runtime/'LICENSE', (Path(sys.base_prefix)/'lib/python3.11/LICENSE.txt').read_bytes())
        support.write_new(runtime/'NOTICE',b'R55 private engineering code-only candidate. D2 resources absent; not activatable. PyInstaller GPL-2.0-or-later with Bootloader-exception; hooks GPL/Apache; bundled numeric native libraries may have GPL runtime exceptions. Original package notices are under bin/_internal. Redistribution clearance NOT established.\n')
        result=post_build(runtime,before)
        collection=wb.json_file(output/'collection.json',8*1024**2)
        missing=set(collection['requiredCode'])-set(collection['pythonModules'])
        if missing:raise ValueError('DARWIN_REQUIRED_CODE_MISSING '+','.join(sorted(missing)))
        result.update({'executionCode':code,'sourceBindings':gate['sourceFiles'],'lockSha256':before['lockSha256'],
          'platformMetadataReceiptSha256':gate['platformPreflightSha256'],
          'installationSha256':before['installationSha256'],'collection':collection,'python':sys.version,
          'pythonExecutable':identity(Path(sys.executable).resolve()),'pythonLicense':identity(runtime/'LICENSE'),
          'packagerVersion':__import__('importlib.metadata',fromlist=['version']).version('pyinstaller'),
          'elapsedSeconds':time.monotonic()-start,'buildEpoch':claim,'exit':exit_code,
          'sbom':{'format':'R55_SHA256_COMPONENT_GRAPH_V1','components':[{**w,'installedRecord':after['wheels'][w['name']]['files']} for w in [*load_lock()['wheels'],*wb.json_file(installation,64*1024**2)['localWheels']]],
                  'sourceFiles':gate['sourceFiles'],'collectedInputs':collection['sourceToCollected'],'outputFiles':result['files'],
                  'python':{'version':sys.version,'executable':identity(Path(sys.executable).resolve())},'existingToolchain':gate['existingToolchain'],
                  'nativeTransformations':['PyInstaller arm64 slice selection','adhoc code signature'],
                  'redistributionClearance':'NOT_ESTABLISHED'}})
        r55_tool_custody.finalize(min(_epoch_deadline,time.monotonic()+5),'pre-receipt')
        closure='CLOSED'
        result['wholeEpochDeadlineSeconds']=3600
        result['originalToolCustody']=r55_tool_custody.projection()
        support.write_new(output/'receipt.json',support.encoded(result))
        support.write_new(private/(claim+'-result.json'),support.encoded({'closure':closure,'status':'PASS','receiptSha256':identity(output/'receipt.json')['sha256'],'exit':exit_code}))
        print('ENGINEERING_CODE_ONLY_NOT_ACTIVATABLE',claim,len(result['files']))
        return result
    except BaseException as e:
        try:r55_tool_custody.finalize(min(_epoch_deadline,time.monotonic()+5),'build-failure')
        except BaseException:
            closure='UNKNOWN'
        if not r55_tool_custody.unknown and all(r['noSpawn'] or (r['started'] and r['handle'].poll() is not None) for r in r55_tool_custody.records):closure='CLOSED'
        # No group/PID cleanup. If the owned builder times out, its hidden worker
        # closure is unknown: retain the original handle/obligation and stop batch.
        result_path=private/(claim+'-result.json')
        failure={'closure':closure,'status':'FAIL','exit':exit_code,'error':str(e)}
        support.write_new(result_path if not result_path.exists() else private/(claim+'-postresult-failure.json'),support.encoded(failure))
        raise
