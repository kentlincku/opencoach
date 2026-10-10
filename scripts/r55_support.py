"""R55 private append-only receipts, bounded official metadata and sticky dispatch.

No runtime or model imports. Claims survive errors and checkout changes.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import urllib.request
from urllib.parse import urlparse

PACKET = '47e4b70fdc82563d7af1a86e90c06ebeedfa4859'
START = '93b3aa07ad2c42e71e97dfcfa36c100d940388b8'

def digest(raw): return hashlib.sha256(raw).hexdigest()
def encoded(value): return (json.dumps(value, sort_keys=True, indent=2)+'\n').encode()

def write_new(path, raw):
    path = Path(path)
    fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(raw)
        while view:
            n = os.write(fd, view)
            if n <= 0: raise ValueError('R55_SHORT_WRITE')
            view = view[n:]
        os.fsync(fd)
    finally: os.close(fd)
    directory = os.open(path.parent, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(directory)
    finally: os.close(directory)
    if read_file(path) != raw: raise ValueError('R55_WRITE_READBACK')

def read_file(path, maximum=4*1024**3):
    path = Path(path)
    for p in (path, *path.parents):
        if stat.S_ISLNK(p.lstat().st_mode): raise ValueError('R55_SYMLINK')
    listed = path.lstat()
    if not stat.S_ISREG(listed.st_mode) or listed.st_nlink != 1 or listed.st_size > maximum:
        raise ValueError('R55_FILE_BOUND')
    fd = os.open(path, os.O_RDONLY|os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        stamp = lambda s: (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_nlink)
        if stamp(before) != stamp(listed): raise ValueError('R55_FILE_CHANGED')
        chunks=[]; size=0
        while b := os.read(fd, min(1024**2, before.st_size-size+1)):
            size+=len(b)
            if size>before.st_size: raise ValueError('R55_FILE_CHANGED')
            chunks.append(b)
        if size!=before.st_size or stamp(os.fstat(fd))!=stamp(before) or stamp(path.lstat())!=stamp(before):
            raise ValueError('R55_FILE_CHANGED')
        return b''.join(chunks)
    finally: os.close(fd)

def private_root(checkout):
    common = subprocess.check_output(['/usr/bin/git','rev-parse','--path-format=absolute','--git-common-dir'],cwd=checkout).decode().strip()
    root=Path(common).parent/'.build/runtime'
    s=root.lstat()
    if not stat.S_ISDIR(s.st_mode) or stat.S_IMODE(s.st_mode)!=0o700 or s.st_uid!=os.getuid():
        raise ValueError('R55_PRIVATE_ROOT')
    return root

def claim(root, kind, binding):
    root=Path(root)
    if kind not in ('build','native'): raise ValueError('R55_CLAIM_KIND')
    if list(root.glob('infrastructure-*-unknown.json')):raise ValueError('R55_INFRASTRUCTURE_CLOSURE_UNKNOWN')
    limit={'build':5,'native':20}[kind]
    claims=sorted([*root.glob('build-*-claim.json'), *root.glob('native-*-claim.json')])
    for p in claims:
        result=p.with_name(p.name.replace('-claim','-result'))
        if not result.exists() or json.loads(read_file(result))['closure']!='CLOSED':
            raise ValueError('R55_UNRESOLVED_DISPATCH')
    count=len(list(root.glob(kind+'-*-claim.json')))
    if count>=limit: raise ValueError('R55_BUDGET_EXHAUSTED')
    # A shared exclusive sequence prevents cross-kind concurrent dispatch. A
    # crash between slot and kind claim blocks reuse rather than hiding an epoch.
    write_new(root/f'dispatch-{len(claims)+1:03d}.lock',encoded({'kind':kind,'sequence':count+1}))
    name=f'{kind}-{count+1:03d}'
    write_new(root/(name+'-claim.json'),encoded({'packet':PACKET,'kind':kind,'sequence':count+1,'binding':binding}))
    return name

class OfficialMetadata:
    def __init__(self, root):
        self.root=Path(root)
    def get(self, url, headers=None):
        headers=headers or {}
        for result in sorted(self.root.glob('metadata-*-result.json')):
            prior=json.loads(read_file(result))
            if prior.get('url')==url and prior.get('headers',{})==headers and prior.get('status')=='PASS':
                raw=read_file(result.with_name(result.name.replace('-result.json','.body')))
                if digest(raw)!=prior['sha256']: raise ValueError('R55_METADATA_CACHE_DRIFT')
                return raw
        # Every HTTP request is sticky and counted before dispatch. No implicit redirect.
        parsed=urlparse(url)
        if parsed.scheme!='https' or parsed.hostname not in ('pypi.org','api.github.com','raw.githubusercontent.com','files.pythonhosted.org') or parsed.username or parsed.password:
            raise ValueError('R55_METADATA_SOURCE')
        previous=list(self.root.glob('metadata-*-claim.json'))
        if len(previous)>=128: raise ValueError('R55_METADATA_REQUEST_LIMIT')
        used=sum(json.loads(read_file(p)).get('bytes',0) for p in self.root.glob('metadata-*-result.json'))
        if used>=64*1024**2: raise ValueError('R55_METADATA_BYTES_LIMIT')
        name=f'metadata-{len(previous)+1:03d}'
        write_new(self.root/(name+'-claim.json'),encoded({'url':url,'headers':headers,'seconds':30}))
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs): raise ValueError('R55_METADATA_REDIRECT')
        start=time.monotonic(); data=bytearray()
        try:
            request=urllib.request.Request(url,headers={'User-Agent':'R55-source-metadata','Accept':'application/json',**headers})
            with urllib.request.build_opener(NoRedirect).open(request,timeout=30) as response:
                while b:=response.read(min(65536,4*1024**2-len(data)+1)):
                    data.extend(b)
                    if len(data)>4*1024**2 or used+len(data)>64*1024**2 or time.monotonic()-start>30:
                        raise ValueError('R55_METADATA_BOUND')
            write_new(self.root/(name+'.body'),bytes(data))
            write_new(self.root/(name+'-result.json'),encoded({'url':url,'headers':headers,'bytes':len(data),'sha256':digest(data),'status':'PASS'}))
            return bytes(data)
        except Exception as e:
            write_new(self.root/(name+'-result.json'),encoded({'url':url,'headers':headers,'bytes':len(data),'status':'FAIL','error':type(e).__name__}))
            raise
