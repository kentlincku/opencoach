"""Offline Windows build admission. No package imports, downloads or runtime trust roots.

The operator binds the private bundle document by SHA256. This is source/build
input validation, NOT S2 model admission, legal clearance or native compatibility.
"""
from __future__ import annotations
import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile

from typing import NoReturn

VENDOR = 'voice_practice_speech_vendor'
CODE_SHA256 = '472a6fdfd3c3820add475fce3f547623098b0978f8e60bb8608ab16b3ec47e80'
SPACY = VENDOR + '/resources/spacy/en_core_web_sm-3.8.0/'
JSON_LIMIT = 2 * 1024 * 1024
PROFILE_LIMIT = 256 * 1024
MAX_FILES = 20000
MAX_FILE = 1024 * 1024 * 1024
MAX_TOTAL = 4 * 1024 * 1024 * 1024
CHUNK = 1024 * 1024
REVIEW_SUBJECTS = {'vendor-code', 'misaki', 'spacy', 'kokoro', 'vad', 'third-party'}


def fail(message) -> NoReturn:
    raise ValueError('Windows bundle: ' + message)


def safe_relative(value):
    if not isinstance(value, str) or len(value) > 240 or not value:
        fail('invalid path')
    parts = value.split('/')
    for part in parts:
        if (not re.fullmatch(r'[A-Za-z0-9_+.,@() -]+', part)
                or part in ('.', '..') or part[-1:] in ('.', ' ')
                or part.split('.')[0].upper() in {'CON','PRN','AUX','NUL',
                    *('COM'+str(i) for i in range(1,10)), *('LPT'+str(i) for i in range(1,10))}):
            fail('unsafe portable path')
    return value


def physical(path, directory=False):
    path = Path(path).absolute()
    for part in (path, *path.parents):
        st = part.lstat()
        if stat.S_ISLNK(st.st_mode) or getattr(st, 'st_file_attributes', 0) & 0x400:
            fail('symlink/reparse path')
    mode = path.stat().st_mode
    if not (stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)):
        fail('nonregular path')
    return path


def stamp(st):
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns


def read_checked(path, limit=MAX_FILE, collect=False):
    path = physical(path)
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    fd = os.open(path, flags)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit or stamp(path.stat()) != stamp(before):
            fail('file bound or identity')
        size, h, chunks = 0, hashlib.sha256(), []
        while block := os.read(fd, min(CHUNK, before.st_size - size + 1)):
            size += len(block)
            if size > before.st_size: fail('file grew')
            h.update(block)
            if collect: chunks.append(block)
        if size != before.st_size or stamp(os.fstat(fd)) != stamp(before) or stamp(physical(path).stat()) != stamp(before):
            fail('file changed')
        return {'bytes':size, 'sha256':h.hexdigest()}, b''.join(chunks)
    finally:
        os.close(fd)


def unique_json(raw):
    def pairs(values):
        out = {}
        for key, value in values:
            if key in out: fail('duplicate JSON key')
            out[key] = value
        return out
    def invalid(_): fail('invalid JSON constant')
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)
    except (ValueError, RecursionError, UnicodeError) as exc:
        fail('invalid JSON: ' + type(exc).__name__)


def json_file(path, limit=JSON_LIMIT):
    return unique_json(read_checked(path, limit, True)[1])


def sha_valid(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def descriptor(value, extra=()):
    if not isinstance(value, dict) or set(value) != {'path','bytes','sha256',*extra}:
        fail('invalid file descriptor')
    safe_relative(value['path'])
    if type(value['bytes']) is not int or not 0 < value['bytes'] <= MAX_FILE or not sha_valid(value['sha256']):
        fail('invalid file identity')
    return value


def verify_file(root, item, extra=()):
    descriptor(item, extra)
    path = Path(root)/item['path']
    actual, _ = read_checked(path)
    if any(actual[k] != item[k] for k in actual): fail('file hash/size mismatch')
    return path


def tree(root):
    root = physical(root, True)
    result, folded, total, count = {}, set(), 0, 0
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            count += 1
            if count > MAX_FILES: fail('tree count limit')
            path = Path(base)/name
            rel = safe_relative(path.relative_to(root).as_posix())
            if rel.casefold() in folded: fail('case collision')
            folded.add(rel.casefold())
            physical(path, name in dirs)
            if name in files:
                actual, _ = read_checked(path)
                total += actual['bytes']
                if total > MAX_TOTAL: fail('tree byte limit')
                result[rel] = actual
    return result


def zip_central_bound(path):
    import struct
    path=physical(path)
    with path.open('rb') as stream:
        stream.seek(0,2); size=stream.tell()
        stream.seek(max(0,size-65557)); end=stream.read(65557)
    offset=end.rfind(b'PK\x05\x06')
    if offset<0 or len(end)-offset<22: fail('ZIP central directory trailer')
    _,disk,start,count_disk,count,cd_size,cd_offset,comment=struct.unpack('<4s4H2IH',end[offset:offset+22])
    if (disk or start or count_disk!=count or count>MAX_FILES or count==65535
            or cd_size>8*1024*1024 or cd_offset+cd_size>size-22-comment
            or offset+22+comment!=len(end)):
        fail('ZIP central directory bound (ZIP64/multidisk not admitted)')


def zip_inventory(path):
    """Streaming bounded ZIP inspection, including every original source member."""
    before, _ = read_checked(path)
    zip_central_bound(path)
    result, names, total = {}, set(), 0
    with zipfile.ZipFile(physical(path)) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_FILES: fail('archive count limit')
        for item in infos:
            name = safe_relative(item.filename.rstrip('/'))
            if name.casefold() in names: fail('duplicate/case archive member')
            names.add(name.casefold())
            mode = item.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or item.flag_bits & 1:
                fail('archive nonregular/encrypted member')
            if item.is_dir():
                if kind == stat.S_IFREG: fail('archive directory mismatch')
                continue
            if kind == stat.S_IFDIR: fail('archive file mismatch')
            total += item.file_size
            if item.file_size > MAX_FILE or total > MAX_TOTAL: fail('archive byte limit')
            h, size = hashlib.sha256(), 0
            with archive.open(item) as stream:
                while block := stream.read(CHUNK):
                    size += len(block)
                    if size > item.file_size: fail('archive growth')
                    h.update(block)
            if size != item.file_size: fail('archive size mismatch')
            result[name] = {'bytes':size, 'sha256':h.hexdigest()}
    if read_checked(path)[0] != before: fail('archive changed')
    return result


def vocab_digest(vocab):
    if (not isinstance(vocab, dict) or not 1 <= len(vocab) <= 4096
            or any(not isinstance(c,str) or len(c)!=1 or type(i) is not int or i<0 for c,i in vocab.items())
            or len(set(vocab.values())) != len(vocab) or not any(vocab.values())):
        fail('invalid vocab')
    return hashlib.sha256(json.dumps(sorted(vocab.items()), ensure_ascii=False, separators=(',',':')).encode()).hexdigest()


def profiles(root, files):
    doc = json_file(root/VENDOR/'resources/kokoro/compatibility.json', PROFILE_LIMIT)
    if not isinstance(doc,dict) or set(doc) != {'schemaVersion','profiles'} or type(doc['schemaVersion']) is not int or doc['schemaVersion'] != 1:
        fail('profile schema')
    entries = doc['profiles']
    if not isinstance(entries,list) or not 1 <= len(entries) <= 32: fail('profile count')
    names, identities, vocab_paths = set(), set(), set()
    for p in entries:
        base = {'profileId','modelBytes','modelSha256','vocabSource','vocabCanonicalSha256'}
        extra = {'relativePath','vocabBytes','vocabFileSha256'}
        if not isinstance(p,dict) or p.get('vocabSource') not in ('embedded','runtime-profile'):
            fail('profile mode')
        if set(p) != base | (extra if p['vocabSource']=='runtime-profile' else set()): fail('profile fields')
        if not isinstance(p['profileId'],str) or not re.fullmatch('[A-Za-z0-9_-]{1,64}',p['profileId']): fail('profile ID')
        if type(p['modelBytes']) is not int or p['modelBytes']<=0 or not sha_valid(p['modelSha256']) or not sha_valid(p['vocabCanonicalSha256']): fail('profile identity')
        identity = p['modelBytes'],p['modelSha256']
        if p['profileId'] in names or identity in identities: fail('duplicate profile')
        names.add(p['profileId']); identities.add(identity)
        if p['vocabSource']=='runtime-profile':
            relative='resources/kokoro/vocabularies/'+p['profileId']+'.json'
            if p['relativePath']!=relative or type(p['vocabBytes']) is not int or not 0<p['vocabBytes']<=PROFILE_LIMIT or not sha_valid(p['vocabFileSha256']): fail('profile vocab identity')
            path=VENDOR+'/'+relative; vocab_paths.add(path)
            expected={'bytes':p['vocabBytes'],'sha256':p['vocabFileSha256']}
            if files.get(path)!=expected or vocab_digest(json_file(root/path,PROFILE_LIMIT))!=p['vocabCanonicalSha256']: fail('profile vocab mismatch')
    if {p for p in files if p.startswith(VENDOR+'/resources/kokoro/vocabularies/')} != vocab_paths:
        fail('undeclared profile vocab')


def admit_resources(bundle, bundle_sha256):
    if not bundle or not sha_valid(bundle_sha256): fail('explicit bundle and SHA256 required')
    path=physical(bundle); root=path.parent
    actual,raw=read_checked(path,JSON_LIMIT,True)
    if actual['sha256']!=bundle_sha256: fail('bundle hash mismatch')
    doc=unique_json(raw)
    if not isinstance(doc,dict) or set(doc)!={'schemaVersion','codeWheel','resourceRoot','files','spacySource','reviews'} or type(doc['schemaVersion']) is not int or doc['schemaVersion']!=1:
        fail('bundle schema')
    code=verify_file(root,doc['codeWheel'])
    if doc['codeWheel']['sha256']!=CODE_SHA256: fail('wrong fixed code wheel')
    code_files=zip_inventory(code)
    payload=physical(root/safe_relative(doc['resourceRoot']),True)
    entries=doc['files']
    if not isinstance(entries,list) or not 1<=len(entries)<=MAX_FILES: fail('resource count')
    expected={}; seen=set(); total=0
    for entry in entries:
        descriptor(entry); p=entry['path']
        if p.casefold() in seen: fail('duplicate/case resource')
        seen.add(p.casefold()); total+=entry['bytes']
        if total>MAX_TOTAL: fail('resource byte limit')
        if (not (p.startswith(SPACY) or p in (VENDOR+'/resources/misaki/en/us_gold.json',
                VENDOR+'/resources/misaki/en/us_silver.json',VENDOR+'/resources/kokoro/compatibility.json',
                VENDOR+'/faster_whisper/assets/silero_vad_v6.onnx')
                or re.fullmatch(VENDOR+r'/resources/kokoro/vocabularies/[A-Za-z0-9_-]{1,64}\.json',p))
                or Path(p).suffix.lower() in {'.py','.pyc','.pyo','.pyd','.dll','.exe','.so','.dylib','.pth','.zip','.whl'}):
            fail('resource destination/executable rejected')
        expected[p]={'bytes':entry['bytes'],'sha256':entry['sha256']}
    actual_tree=tree(payload)
    if expected!=actual_tree: fail('resource inventory mismatch (missing/extra/changed)')
    required={VENDOR+'/resources/misaki/en/us_gold.json',VENDOR+'/resources/misaki/en/us_silver.json',
              VENDOR+'/resources/kokoro/compatibility.json',VENDOR+'/faster_whisper/assets/silero_vad_v6.onnx'}
    required|={SPACY+p for p in ('meta.json','config.cfg','tokenizer','tok2vec/model','tagger/model','vocab/strings.json','LICENSE','LICENSES_SOURCES')}
    if not required<=expected.keys(): fail('required resource missing')
    spacy=doc['spacySource']; archive=verify_file(root,spacy,('prefix',))
    prefix=safe_relative(spacy['prefix'])+'/'
    original=zip_inventory(archive)
    mapped={SPACY+p[len(prefix):]:v for p,v in original.items() if p.startswith(prefix)}
    if not mapped or mapped!={p:v for p,v in expected.items() if p.startswith(SPACY)}:
        fail('incomplete original spaCy directory')
    meta=json_file(payload/(SPACY+'meta.json'))
    if not isinstance(meta,dict) or meta.get('lang')!='en' or meta.get('name')!='core_web_sm' or meta.get('version')!='3.8.0': fail('spaCy model identity')
    pipeline=meta.get('pipeline')
    if not isinstance(pipeline,list) or not {'tok2vec','tagger'}<=set(pipeline): fail('spaCy pipeline')
    for component in pipeline:
        safe_relative(component)
        if not any(p.startswith(SPACY+component+'/') for p in expected): fail('missing spaCy component')
    profiles(payload,expected)
    reviews=doc['reviews']
    if not isinstance(reviews,dict) or set(reviews)!=REVIEW_SUBJECTS: fail('rights/review evidence required')
    review_files={}
    for subject,item in reviews.items():
        review=verify_file(root,item)
        read_checked(review,JSON_LIMIT)
        review_files[subject]=str(review)
    if read_checked(path,JSON_LIMIT)[0]['sha256']!=bundle_sha256: fail('bundle changed')
    return dict(bundle=str(path), bundleSha256=bundle_sha256, codeWheel=str(code), codeSha256=CODE_SHA256,
                codeFiles=code_files, resourceRoot=str(payload), files=dict(sorted(expected.items())),
                reviews=review_files, document=doc, status='INPUT_BYTES_VERIFIED_NATIVE_AND_RIGHTS_NOT_CLEARED')


FORBIDDEN = {'kokoro','kokoro-onnx','misaki','faster-whisper','av','soundfile','libsndfile',
             'ffmpeg','espeak','espeakng-loader','phonemizer','phonemizer-fork','num2words',
             'onnxruntime-gpu','onnxruntime-directml','torch','torchaudio'}
EXCLUDES = sorted(FORBIDDEN | {p.replace('-','_') for p in FORBIDDEN})
BINARY_DENY = re.compile(r'(?:avcodec|avformat|avutil|avdevice|avfilter|swresample|swscale|ffmpeg|sndfile|espeak|phonemizer|cuda|cudnn|cublas|cufft|curand|nvrtc|nvinfer|directml|providers_dml|providers_tensorrt)', re.I)


def normalize(name):
    return re.sub('[-_.]+','-',name).lower()


def forbidden_path(path, *, windows_target=False):
    parts = path.replace('\\','/').split('/')
    # Private namespaced patched K/M/F are permitted, upstream aliases are not.
    top = normalize(parts[0].split('.')[0])
    # Strict by default (darwin_bundle shares this guard): an accelerator
    # spelling in ANY segment, including the leaf filename, is refused.  Only the
    # Windows bundle target exempts the leaf; native leaves are still checked by
    # BINARY_DENY below.
    segments = parts[:-1] if windows_target else parts
    if top in FORBIDDEN or any(normalize(p).startswith(('nvidia-','onnxruntime-gpu','onnxruntime-directml')) for p in segments):
        return True
    # Hooks/docs may legitimately name an unavailable accelerator. A spelling
    # inside a hash-locked Python filename is not evidence of a shipped binary.
    native = re.search(r'\.(?:dll|pyd|exe|dylib|so(?:\.\d+)*|cubin|ptx|fatbin|bin)$', parts[-1], re.I)
    return bool(native and BINARY_DENY.search(parts[-1]))


def parse_lock(path):
    text=read_checked(path,JSON_LIMIT,True)[1].decode('utf-8')
    text=text.replace('\\\r\n',' ').replace('\\\n',' ')
    locked={}
    for line in text.splitlines():
        line=line.strip()
        if not line or line.startswith('#') or line=='--only-binary=:all:': continue
        match=re.fullmatch(r'([a-z0-9][a-z0-9._-]*)==([a-zA-Z0-9.+!_-]+)((?:\s+--hash=sha256:[a-f0-9]{64})+)',line)
        if not match: fail('lock must contain only exact versions and hashes')
        name,version,hashes=match.groups(); name=normalize(name)
        if name in locked or name in FORBIDDEN or name.startswith('nvidia-') or name=='voice-practice-speech-vendor': fail('duplicate/forbidden lock package')
        values=re.findall('sha256:([a-f0-9]{64})',hashes)
        if len(values)!=len(set(values)): fail('duplicate lock hash')
        locked[name]={'version':version,'hashes':set(values)}
    if not 1<=len(locked)<=256: fail('lock count')
    return locked


def compatible_tag(python,abi,platform):
    if platform not in ('any','win_amd64'): return False
    for p in python.split('.'):
        if p in ('py3','py311') and abi=='none': return True
        if p=='cp311' and abi in ('cp311','none') and platform=='win_amd64': return True
        if re.fullmatch(r'cp3[0-9]{1,2}',p) and abi=='abi3' and platform=='win_amd64' and 2<=int(p[3:])<=11: return True
    return False


def wheel_inventory(path):
    """Verify filename/metadata/RECORD without importing anything from the wheel."""
    from email.parser import BytesParser
    filename=Path(path).name
    match=re.fullmatch(r'([A-Za-z0-9_.]+)-([A-Za-z0-9_.+!]+)(?:-([0-9][A-Za-z0-9_.]*))?-([A-Za-z0-9_.]+)-([A-Za-z0-9_.]+)-([A-Za-z0-9_.]+)\.whl',filename)
    if not match: fail('wheel filename')
    name,version,build,py,abi,plat=match.groups()
    if not compatible_tag(py,abi,plat): fail('wrong Windows CPython3.11 wheel tag')
    if normalize(name) in FORBIDDEN or normalize(name).startswith('nvidia-'): fail('forbidden wheel')
    files=zip_inventory(path)
    for p in files:
        if p == 'ctranslate2/cudnn64_9.dll' and normalize(name) == 'ctranslate2':
            continue
        if forbidden_path(p, windows_target=True): fail('forbidden wheel content')
    infos={p.split('/')[0] for p in files if p.split('/')[0].endswith('.dist-info')}
    expected=f'{name}-{version}.dist-info'
    if infos!={expected}: fail('wheel dist-info identity')
    with zipfile.ZipFile(path) as archive:
        def small(member):
            if member not in files or files[member]['bytes']>JSON_LIMIT: fail('wheel metadata missing/oversize')
            return archive.read(member)
        meta=BytesParser().parsebytes(small(expected+'/METADATA'))
        if meta.get_all('Name')!=[meta.get('Name')] or normalize(meta.get('Name',''))!=normalize(name) or meta.get_all('Version')!=[version]: fail('wheel metadata identity')
        tags=BytesParser().parsebytes(small(expected+'/WHEEL')).get_all('Tag',[])
        if not tags or any(len(tag.split('-'))!=3 for tag in tags): fail('wheel metadata tags')
        expanded={f'{p}-{a}-{t}' for p in py.split('.') for a in abi.split('.') for t in plat.split('.')}
        if set(tags)!=expanded: fail('filename/WHEEL tags mismatch')
        record=expected+'/RECORD'; rows=list(csv.reader(io.StringIO(small(record).decode('utf-8'))))
    observed=set()
    for row in rows:
        if len(row)!=3 or row[0] in observed or row[0] not in files: fail('wheel RECORD inventory')
        p,encoded,size=row; observed.add(p)
        if p==record:
            if encoded or size: fail('wheel RECORD self hash')
            continue
        wanted='sha256='+base64.urlsafe_b64encode(bytes.fromhex(files[p]['sha256'])).rstrip(b'=').decode()
        if encoded!=wanted or size!=str(files[p]['bytes']): fail('wheel RECORD hash/size')
    if observed!=set(files): fail('wheel RECORD missing member')
    return {'name':normalize(name),'version':version,'files':files,'path':str(Path(path).absolute()),'identity':read_checked(path)[0]}


def admit_wheelhouse(lock, wheelhouse):
    locked=parse_lock(lock); house=physical(wheelhouse,True)
    members=tree(house)
    if not 1<=len(members)<=256 or any('/' in p or not p.endswith('.whl') for p in members): fail('wheelhouse only exact wheels')
    wheels={}; destinations=set()
    for p in sorted(members):
        wheel=wheel_inventory(house/p); name=wheel['name']
        if name not in locked or name in wheels: fail('extra/duplicate wheel')
        if wheel['version']!=locked[name]['version'] or wheel['identity']['sha256'] not in locked[name]['hashes']: fail('wheel not hash locked')
        for dest in wheel['files']:
            if dest.casefold() in destinations: fail('cross-wheel collision')
            destinations.add(dest.casefold())
        wheels[name]=wheel
    if set(wheels)!=set(locked): fail('missing locked wheel')
    return wheels


def write_new(path, data):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('xb') as f: f.write(data)


def copy_bound(src, dst, expected):
    """Fail before writing any byte beyond the admitted size, including growth."""
    size, digest = 0, hashlib.sha256()
    while block := src.read(min(CHUNK, expected['bytes'] - size + 1)):
        size += len(block)
        if size > expected['bytes']:
            fail('copy exceeds admitted byte bound')
        digest.update(block)
        dst.write(block)
    if size != expected['bytes'] or digest.hexdigest() != expected['sha256']:
        fail('copy content changed')


def build_vendor(admitted, output):
    """Distinct deterministic resource-bearing wheel; original code/provenance unchanged."""
    code=wheel_inventory(admitted['codeWheel'])
    version='0.1.0+kmf.s4.'+admitted['bundleSha256'][:16]
    dist=f'{VENDOR}-{version}.dist-info'
    name=f'{VENDOR}-{version}-py3-none-any.whl'
    output=Path(output)
    source=output/'source'; source.mkdir()
    identities={}
    with zipfile.ZipFile(admitted['codeWheel']) as archive:
        for member,item in sorted(code['files'].items()):
            if not member.startswith(VENDOR+'/'): continue
            target=source/member
            target.parent.mkdir(parents=True,exist_ok=True)
            with archive.open(member) as src, target.open('xb') as dst:
                copy_bound(src, dst, item)
            if read_checked(target)[0]!=item: fail('code copy changed')
            identities[member]=item
    for member,item in admitted['files'].items():
        target=source/member
        target.parent.mkdir(parents=True,exist_ok=True)
        with physical(Path(admitted['resourceRoot'])/member).open('rb') as src, target.open('xb') as dst:
            copy_bound(src, dst, item)
        if read_checked(target)[0]!=item: fail('resource copy changed')
        identities[member]=item
    for subject,path in sorted(admitted['reviews'].items()):
        member=VENDOR+'/notices/s4/'+subject+'.txt'
        item,raw=read_checked(path,JSON_LIMIT,True)
        if item!={k:admitted['document']['reviews'][subject][k] for k in ('bytes','sha256')}: fail('review changed')
        write_new(source/member,raw); identities[member]=item
    provenance={'schemaVersion':1,'codeWheelSha256':CODE_SHA256,'bundleSha256':admitted['bundleSha256'],
                'input':admitted['document'],'resourceBytesVerified':True,'nativeCompatibility':'NOT_RUN',
                'redistributionClearance':'OPERATOR_REVIEW_REQUIRED','originalCodeOnlyProvenancePreserved':True}
    generated={VENDOR+'/s4-build-provenance.json':json.dumps(provenance,sort_keys=True,indent=2).encode()+b'\n',
               dist+'/METADATA':f'Metadata-Version: 2.1\nName: voice-practice-speech-vendor\nVersion: {version}\nSummary: Fixed patched code plus operator-inventoried resources; no native clearance\nRequires-Python: >=3.11,<3.12\n'.encode(),
               dist+'/WHEEL':b'Wheel-Version: 1.0\nGenerator: voice-practice-s4\nRoot-Is-Purelib: true\nTag: py3-none-any\n'}
    for member,raw in generated.items():
        write_new(source/member,raw); identities[member]=read_checked(source/member)[0]
    rows=[]
    for member,item in sorted(identities.items()):
        rows.append((member,'sha256='+base64.urlsafe_b64encode(bytes.fromhex(item['sha256'])).rstrip(b'=').decode(),str(item['bytes'])))
    record=dist+'/RECORD'; rows.append((record,'',''))
    stream=io.StringIO(); csv.writer(stream,lineterminator='\n').writerows(rows)
    write_new(source/record,stream.getvalue().encode())
    with zipfile.ZipFile(output/name,'x',compression=zipfile.ZIP_DEFLATED) as archive:
        for member in sorted([*identities,record]):
            info=zipfile.ZipInfo(member,(1980,1,1,0,0,0)); info.external_attr=(stat.S_IFREG|0o644)<<16
            info.compress_type=zipfile.ZIP_DEFLATED
            with (source/member).open('rb') as src, archive.open(info,'w') as dst:
                copy_bound(src, dst, read_checked(source/member)[0] if member==record else identities[member])
    result=wheel_inventory(output/name)
    return name,result


def prepare(bundle, bundle_sha256, wheelhouse, output, lock):
    admitted=admit_resources(bundle,bundle_sha256)
    wheels=admit_wheelhouse(lock,wheelhouse)
    output=Path(output).absolute()
    physical(output.parent,True)
    output.mkdir()  # Never overwrite/reuse or clean caller-owned/shared directories.
    name,vendor=build_vendor(admitted,output)
    text=read_checked(lock,JSON_LIMIT,True)[1].decode('utf-8')
    text+='\nvoice-practice-speech-vendor @ '+(output/name).as_uri()+' --hash=sha256:'+vendor['identity']['sha256']+'\n'
    write_new(output/'install.lock.txt',text.encode())
    report={'status':'PREPARED_INPUT_BYTES_ONLY','bundle':str(Path(bundle).absolute()),'bundleSha256':bundle_sha256,
            'lockSha256':read_checked(lock)[0]['sha256'],'wheelhouse':str(Path(wheelhouse).absolute()),
            'vendorWheel':name,'vendorSha256':vendor['identity']['sha256'],
            'publicWheels':{k:{'filename':Path(v['path']).name,**v['identity']} for k,v in wheels.items()},
            'native':'NOT_RUN','legalClearance':'NOT_RUN'}
    write_new(output/'preparation.json',json.dumps(report,sort_keys=True,indent=2).encode()+b'\n')
    return report


DEFAULT_LOCK = Path(__file__).with_name('requirements-windows-x64.lock.txt')


def require_native():
    import platform
    import struct
    import sys
    if (platform.system()!='Windows' or platform.machine().lower() not in ('amd64','x86_64')
            or platform.python_implementation()!='CPython' or sys.version_info[:2]!=(3,11) or struct.calcsize('P')!=8):
        fail('native Windows x64 CPython3.11 required')
    if sys.prefix==sys.base_prefix or os.environ.get('PYTHONPATH') or os.environ.get('PYTHONHOME'):
        fail('isolated dedicated virtual environment required (no PYTHONPATH/PYTHONHOME)')


def verify_prepared(bundle, bundle_sha256, wheelhouse, prepared, lock=None):
    lock=lock or DEFAULT_LOCK
    admitted=admit_resources(bundle,bundle_sha256)
    wheels=admit_wheelhouse(lock,wheelhouse)
    prepared=physical(prepared,True)
    report=json_file(prepared/'preparation.json')
    version='0.1.0+kmf.s4.'+bundle_sha256[:16]
    filename=f'{VENDOR}-{version}-py3-none-any.whl'
    if (report.get('bundleSha256')!=bundle_sha256 or report.get('vendorWheel')!=filename
            or report.get('lockSha256')!=read_checked(lock)[0]['sha256']): fail('prepared input binding')
    vendor=wheel_inventory(prepared/filename)
    if vendor['identity']['sha256']!=report.get('vendorSha256'): fail('prepared wheel changed')
    public={k:{'filename':Path(v['path']).name,**v['identity']} for k,v in wheels.items()}
    if report.get('publicWheels')!=public: fail('prepared wheelhouse changed')
    source=physical(prepared/'source',True)
    if tree(source)!=vendor['files']: fail('prepared source content mismatch')
    expected={p:v for p,v in admitted['codeFiles'].items() if p.startswith(VENDOR+'/')}
    expected.update(admitted['files'])
    for subject,item in admitted['document']['reviews'].items():
        expected[VENDOR+'/notices/s4/'+subject+'.txt']={k:item[k] for k in ('bytes','sha256')}
    for p,item in expected.items():
        if vendor['files'].get(p)!=item: fail('prepared code/resource content mismatch')
    dist=f'{VENDOR}-{version}.dist-info/'
    extras={VENDOR+'/s4-build-provenance.json',dist+'METADATA',dist+'WHEEL',dist+'RECORD'}
    if set(vendor['files'])!=set(expected)|extras: fail('prepared extra/missing files')
    provenance=json_file(source/VENDOR/'s4-build-provenance.json')
    if provenance.get('input')!=admitted['document'] or provenance.get('codeWheelSha256')!=CODE_SHA256 or provenance.get('bundleSha256')!=bundle_sha256:
        fail('prepared provenance mismatch')
    wheels[vendor['name']]=vendor
    datas=[(str(source/p),str(PurePosixPath(p).parent)) for p in sorted(vendor['files']) if not p.endswith('.py')]
    modules=[]; compiled=[]
    for p in sorted(vendor['files']):
        if not p.endswith('.py'): continue
        name=p[:-3].replace('/','.')
        modules.append(name.removesuffix('.__init__'))
        compiled.append(p[:-3]+'.pyc')
    return dict(admitted=admitted,wheels=wheels,source=str(source),datas=datas,compiled=compiled,
                hiddenimports=sorted(set(modules)|{'voice_runtime.backends.fake','voice_runtime.backends.kokoro_onnx',
                    'voice_runtime.backends.faster_whisper','onnxruntime','ctranslate2','tokenizers','spacy.lang.en',
                    'spacy.pipeline','inflect','regex','addict'}),excludes=EXCLUDES,
                bundleSha256=bundle_sha256,vendorSha256=vendor['identity']['sha256'])


def installed_destination(member, site_root):
    import sysconfig
    parts=member.split('/')
    if parts[0].endswith('.data'):
        if len(parts)<3: fail('wheel data scheme')
        scheme=parts[1]
        if scheme in ('purelib','platlib'): return Path(site_root).joinpath(*parts[2:])
        destinations={'scripts':sysconfig.get_path('scripts'),'data':sysconfig.get_path('data'),'headers':sysconfig.get_path('include')}
        if scheme not in destinations: fail('wheel data scheme')
        return Path(destinations[scheme]).joinpath(*parts[2:])
    return Path(site_root)/member


def verify_installed(plan, distributions=None, roots=None):
    """Compare actual installed files to locked wheel bytes, not version labels alone."""
    import importlib.metadata
    import sysconfig
    if distributions is None: distributions=importlib.metadata.distributions()
    if roots is None: roots={sysconfig.get_path('purelib'),sysconfig.get_path('platlib')}
    actual={}
    for dist in distributions:
        name=normalize(dist.metadata.get('Name',''))
        if name in actual or not name: fail('duplicate installed distribution')
        actual[name]=dist
    if set(actual)!=set(plan['wheels']): fail('installed distributions differ from complete lock; use a dedicated clean venv')
    allowed=set()
    for name,wheel in plan['wheels'].items():
        dist=actual[name]
        if dist.version!=wheel['version']: fail('installed version mismatch')
        site=physical(dist.locate_file(''),True)
        for member,item in wheel['files'].items():
            destination=installed_destination(member,site)
            allowed.add(str(destination.absolute()).casefold())
            if member.endswith('.dist-info/RECORD'): continue  # installer necessarily rewrites RECORD
            if read_checked(destination)[0]!=item: fail('installed file differs from locked wheel')
        # Only inert installer bookkeeping may be added; no unowned executable code.
        distdir=next(p.split('/')[0] for p in wheel['files'] if p.endswith('.dist-info/METADATA'))
        for name in ('INSTALLER','REQUESTED','direct_url.json','uv_cache.json'):
            allowed.add(str((site/distdir/name).absolute()).casefold())
    for root in roots:
        for member in tree(root):
            full=str((Path(root)/member).absolute()).casefold()
            if full not in allowed: fail('unlocked installed file (including stale bytecode)')
    return {name:str(dist.locate_file('')) for name,dist in actual.items()}


def validate_collection(analysis, plan):
    for name,*rest in [*analysis.pure,*analysis.binaries,*analysis.datas]:
        if forbidden_path(name, windows_target=True): fail('forbidden collected module/native alias')
    expected={str(PurePosixPath(dest)/Path(src).name):read_checked(src)[0] for src,dest in plan['datas']}
    observed={}; destinations=set()
    for name,path,*kind in analysis.datas:
        # Only TOC destinations use host separators; inventory/ZIP paths stay strict.
        # Replace separators without collapsing traversal, absolute or empty parts.
        name=safe_relative(name.replace('\\','/'))
        folded=name.casefold()
        if folded in destinations: fail('duplicate collected resource')
        destinations.add(folded)
        if name in expected:
            observed[name]=read_checked(path)[0]
    if observed!=expected: fail('collected resource missing/changed/remapped')


def post_build(runtime, plan):
    runtime=physical(runtime,True)
    files=tree(runtime)
    if not files.get('voice-runtime.exe',{}).get('bytes'): fail('missing onedir entrypoint')
    if any(p!='voice-runtime.exe' and not p.startswith('_internal/') for p in files): fail('wrong onedir/_internal layout')
    internal={p[len('_internal/'):]:v for p,v in files.items() if p.startswith('_internal/')}
    for p in internal:
        if forbidden_path(p, windows_target=True): fail('forbidden post-build package/native alias')
        if p.endswith('.zip'):
            if any(forbidden_path(n, windows_target=True) for n in zip_inventory(runtime/'_internal'/p)): fail('forbidden archive alias')
    expected={str(PurePosixPath(dest)/Path(src).name):read_checked(src)[0] for src,dest in plan['datas']}
    for p,v in expected.items():
        if internal.get(p)!=v: fail('post-build resource/content mismatch')
    vendor={p for p in internal if p.startswith(VENDOR+'/')}
    expected_vendor={p for p in expected if p.startswith(VENDOR+'/')}|set(plan['compiled'])
    if vendor!=expected_vendor: fail('post-build vendor code/resource inventory mismatch')
    return {'status':'POST_BUILD_FILES_VERIFIED_CANDIDATE_ONLY','bundleSha256':plan['bundleSha256'],
            'vendorSha256':plan['vendorSha256'],'files':dict(sorted(files.items())),
            'nativeInference':'NOT_RUN','redistributionClearance':'NOT_RUN'}
