"""Deterministic code-only wheels; immutable source bytes and existing K/M patches.

No D2 placeholders, no build backend and no upstream algorithm changes.
"""
import base64
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('speech_vendor',ROOT/'scripts/build-speech-vendor.py')
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
sha=lambda b:hashlib.sha256(b).hexdigest()

def wheel(output,name,version,files,requirements,tag='py3-none-any'):
    dist=name+'-'+version+'.dist-info'
    files=dict(files)
    files[dist+'/METADATA']=('Metadata-Version: 2.1\nName: '+name.replace('_','-')+'\nVersion: '+version+'\nRequires-Python: >=3.11,<3.12\n'+''.join('Requires-Dist: '+r+'\n' for r in requirements)+'\nCODE ONLY; D2 resources missing; NOT ACTIVATABLE.\n').encode()
    files[dist+'/WHEEL']=('Wheel-Version: 1.0\nGenerator: R55-code-only\nRoot-Is-Purelib: '+('true' if tag=='py3-none-any' else 'false')+'\nTag: '+tag+'\n').encode()
    rows=[(p,'sha256='+base64.urlsafe_b64encode(bytes.fromhex(sha(b))).rstrip(b'=').decode(),str(len(b))) for p,b in sorted(files.items())]
    rows.append((dist+'/RECORD','',''));s=io.StringIO();csv.writer(s,lineterminator='\n').writerows(rows);files[dist+'/RECORD']=s.getvalue().encode()
    filename=name+'-'+version+'-'+tag+'.whl'
    with zipfile.ZipFile(Path(output)/filename,'x',compression=zipfile.ZIP_DEFLATED) as z:
        for p,b in sorted(files.items()):
            info=zipfile.ZipInfo(p,(1980,1,1,0,0,0));info.external_attr=0o100644<<16;info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,b)
    raw=(Path(output)/filename).read_bytes()
    return {'name':name.replace('_','-'),'version':version,'filename':filename,'bytes':len(raw),'sha256':sha(raw),
            'role':'D1_LOCAL_CODE_VENDOR','requiresDist':requirements,'tags':[tag]}

def source_files(lock,cache):
    out={}
    for item in lock:
        source=Path(cache)/item['cacheFile'];raw=source.read_bytes()
        if len(raw)!=item['bytes'] or sha(raw)!=item['sha256']:raise ValueError('VENDOR_SOURCE_DRIFT')
        if item.get('original')=='pyproject.toml':continue
        out[item['destination']]=raw
    return out

def build(lock,cache,wheelhouse,source_house=None):
    outputs=[]
    ort=lock['onnxruntimeCodeSource'];ortfiles={}
    for member in ort['selectedMembers']:
        original=member['path'];raw=(Path(cache)/'ort-source'/original).read_bytes()
        if len(raw)!=member['bytes'] or sha(raw)!=member['sha256']:raise ValueError('ORT_VENDOR_SOURCE_DRIFT')
        if original.startswith('onnxruntime-1.22.1.dist-info/'):
            suffix=original.split('/',1)[1]
            if suffix in ('METADATA','WHEEL'):suffix='r55-original-'+suffix
            if suffix=='RECORD':continue
            original='onnxruntime-'+ort['version']+'.dist-info/'+suffix
        ortfiles[original]=raw
    original_record=(Path(cache)/'ort-original-RECORD.csv').read_bytes()
    if sha(original_record)!=ort['originalRecordSha256']:raise ValueError('ORT_ORIGINAL_RECORD_DRIFT')
    ortfiles['onnxruntime-'+ort['version']+'.dist-info/r55-original-RECORD.csv']=original_record
    ortfiles['onnxruntime-'+ort['version']+'.dist-info/r55-selected-source.json']=(json.dumps(ort,sort_keys=True,indent=2)+'\n').encode()
    outputs.append(wheel(wheelhouse,'onnxruntime',ort['version'],ortfiles,ort['originalWheel']['requiresDist'],ort['originalWheel']['tags'][0]))
    mlx=source_files(lock['sources']['mlx-whisper']['source'],cache)
    outputs.append(wheel(wheelhouse,'mlx_whisper','0.4.3+codeonly.r55',mlx,
      ['mlx==0.32.2','numba==0.61.2','numpy==2.2.6','scipy==1.15.3','tiktoken==0.9.0','huggingface-hub==0.34.4','tqdm==4.67.1','more-itertools==10.7.0']))
    lang=source_files(lock['sources']['langcodes']['source'],cache)
    outputs.append(wheel(wheelhouse,'langcodes','3.3.0+codeonly.r55',lang,[]))
    misaki=source_files(lock['sources']['misaki']['source'],cache)
    k=v.read_kokoro(Path(source_house or wheelhouse)/lock['kokoroSource']['filename'])
    files={p:b for p,b in k.items() if p.endswith('.py')}
    files.update({i['original']:misaki[i['destination']] for i in lock['sources']['misaki']['source'] if i['original'].endswith('.py')})
    patch_receipts={}
    for name in ['kokoro-onnx-0.6.1-explicit-tokenizer.patch','misaki-e820629-offline-injection.patch']:
        raw=(ROOT/'patches'/name).read_bytes()
        if sha(raw)!=lock['patches'][name]:raise ValueError('VENDOR_PATCH_DRIFT')
        v.apply_patch(files,raw,v.PATCHES[name]);patch_receipts[name]=sha(raw)
    files={'voice_practice_speech_vendor/'+p:b for p,b in files.items()}
    files['voice_practice_speech_vendor/__init__.py']=b'"""Code-only Darwin K/M vendor. Real resources are mandatory."""\nCODE_ONLY=True\n'
    files['voice_practice_speech_vendor/notices/kokoro-onnx-LICENSE']=k['kokoro_onnx-0.6.1.dist-info/licenses/LICENSE']
    files['voice_practice_speech_vendor/notices/misaki-LICENSE']=misaki['notices/misaki-LICENSE']
    files['voice_practice_speech_vendor/provenance.json']=(json.dumps({'sourceLockSha256':sha(json.dumps(lock,sort_keys=True).encode()),'patches':patch_receipts,'d2Complete':False,'sources':lock['sources']},sort_keys=True,indent=2)+'\n').encode()
    outputs.append(wheel(wheelhouse,'voice_practice_speech_vendor','0.1.0+darwin.r55',files,
      ['numpy==2.2.6','onnxruntime==1.22.1','addict==2.4.0','regex==2024.11.6','spacy==3.8.7','inflect==7.5.0']))
    guard={'r55_build_guard.py':(Path(__file__).with_name('r55_build_guard.py')).read_bytes(),
           'r55_tool_custody.py':(Path(__file__).with_name('r55_tool_custody.py')).read_bytes(),
           '00_r55_build_guard.pth':b'import sys; sys.dont_write_bytecode=True; import r55_build_guard\n'}
    outputs.append(wheel(wheelhouse,'r55_build_guard','1.0',guard,[]))
    return outputs
