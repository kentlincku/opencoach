"""Selected official ORT wheel code/native members, never model member bodies."""
import hashlib,json,os,struct,time,urllib.request,zlib
from pathlib import Path
import importlib.util
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('r55_ort_support',ROOT/'scripts/r55_support.py');s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)

def validate_source(source):
    if source['role']!='D1_SELECTED_OFFICIAL_WHEEL_MEMBERS' or source['wholeWheelAcquisitionAllowed'] is not False or source['wholeWheelSha256Verified'] is not False:
        raise ValueError('R55_ORT_WHOLE_WHEEL_FORBIDDEN')
    members=source['selectedMembers'];seen=set()
    for member in members:
        p=member['path']
        if p in seen or p.startswith('/') or any(x in ('','.','..') for x in p.split('/')) or not p.startswith(('onnxruntime/','onnxruntime-1.22.1.dist-info/')) or p.endswith(('.onnx','.npz','.npy','.csv','.safetensors','.tiktoken')) or member['flags']!=0 or member['compression']not in (0,8) or not 0<member['spanBytes']<=4*1024**3 or len(member['sha256'])!=64:
            raise ValueError('R55_ORT_D1_MEMBER_SCOPE')
        seen.add(p)
    ranges=source['ranges'];last=-1;range_members=[]
    for part in ranges:
        if not (last<part['start']<=part['end']<source['centralOffset']) or not part['members']:raise ValueError('R55_ORT_RANGE_ORDER')
        offset=part['start']
        for member in part['members']:
            if member not in members or member['headerOffset']!=offset:raise ValueError('R55_ORT_RANGE_MEMBER_DRIFT')
            offset+=member['spanBytes'];range_members.append(member['path'])
        if offset!=part['end']+1:raise ValueError('R55_ORT_RANGE_BOUND')
        if any(part['start']<=m['headerOffset']<=part['end'] for m in source['excludedD2Members']):raise ValueError('R55_ORT_RANGE_CROSSES_MODEL')
        last=part['end']
    if len(range_members)!=len(seen) or set(range_members)!=seen or len(ranges)>64:raise ValueError('R55_ORT_RANGE_CLOSURE')
    if not {'onnxruntime/__init__.py','onnxruntime/capi/onnxruntime_pybind11_state.so'}<=seen:raise ValueError('R55_ORT_RUNTIME_CODE_MISSING')
    return True

def decode_member(fragment,member,range_start):
    offset=member['headerOffset']-range_start
    v=struct.unpack('<4s5H3I2H',fragment[offset:offset+30])
    if v[0]!=b'PK\x03\x04' or v[2]!=0 or v[3]!=member['compression'] or v[6]!=member['crc32'] or v[7]!=member['compressedBytes'] or v[8]!=member['bytes']:
        raise ValueError('R55_ORT_LOCAL_HEADER')
    name=fragment[offset+30:offset+30+v[9]].decode('utf-8')
    if name!=member['path']:raise ValueError('R55_ORT_MEMBER_NAME')
    begin=offset+30+v[9]+v[10];end=begin+member['compressedBytes']
    if end!=offset+member['spanBytes']:raise ValueError('R55_ORT_UNKNOWN_SPAN_BYTES')
    if v[3]==8:
        decoder=zlib.decompressobj(-15);raw=decoder.decompress(fragment[begin:end],member['bytes']+1)
        if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:raise ValueError('R55_ORT_DEFLATE_BOUND')
    else:raw=fragment[begin:end]
    if len(raw)!=member['bytes'] or zlib.crc32(raw)!=member['crc32'] or s.digest(raw)!=member['sha256']:
        raise ValueError('R55_ORT_RECORD_BOUND_BYTES')
    return raw

def acquire(source,private):
    validate_source(source)
    private=Path(private);root=private/'ort-source';root.mkdir(mode=0o700)
    original=s.read_file(private/'ort-original-RECORD.csv')
    if s.digest(original)!=source['originalRecordSha256']:raise ValueError('R55_ORT_ORIGINAL_RECORD_DRIFT')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):raise ValueError('R55_ORT_REDIRECT')
    opener=urllib.request.build_opener(NoRedirect);receipts=[];received=0
    for i,part in enumerate(source['ranges'],1):
        expected=part['end']-part['start']+1
        disk=os.statvfs(private)
        if disk.f_bavail*disk.f_frsize<expected+1024**3:raise ValueError('R55_ORT_DISK_RESERVE')
        s.write_new(private/f'ort-range-{i:03d}-claim.json',s.encoded({'url':source['originalWheel']['url'],**part}))
        start=time.monotonic();path=private/f'ort-range-{i:03d}.zipfragment';size=0;h=hashlib.sha256();phase='headers';items={}
        result=private/f'ort-range-{i:03d}-result.json'
        request=urllib.request.Request(source['originalWheel']['url'],headers={'User-Agent':'R55-reviewed-D1-members','Accept-Encoding':'identity','Range':f"bytes={part['start']}-{part['end']}"})
        try:
            with opener.open(request,timeout=30) as response:
                if response.status!=206 or response.geturl()!=source['originalWheel']['url'] or response.headers.get('Content-Encoding','identity').lower()!='identity' or response.headers.get('Content-Range')!=f"bytes {part['start']}-{part['end']}/{source['originalWheel']['bytes']}" or int(response.headers['Content-Length'])!=expected:
                    raise ValueError('R55_ORT_RESPONSE_RANGE')
                phase='receive'
                with path.open('xb') as out:
                    try:
                        while block:=response.read(min(1024**2,expected-size+1)):
                            size+=len(block);received+=len(block);h.update(block)
                            if size>expected or time.monotonic()-start>1200:raise ValueError('R55_ORT_RECEIVE_BOUND')
                            out.write(block)
                    finally:out.flush();os.fsync(out.fileno())
            if size!=expected:raise ValueError('R55_ORT_RANGE_SIZE')
            phase='readback';fragment=s.read_file(path)
            if s.digest(fragment)!=h.hexdigest():raise ValueError('R55_ORT_RANGE_READBACK')
            phase='member-verification'
            for member in part['members']:
                raw=decode_member(fragment,member,part['start']);target=root/member['path'];target.parent.mkdir(parents=True,exist_ok=True)
                s.write_new(target,raw);items[member['path']]={'bytes':len(raw),'sha256':s.digest(raw)}
            receipt={'url':source['originalWheel']['url'],'range':{k:part[k]for k in ('start','end')},'receivedBytes':size,'compressedRangeSha256':h.hexdigest(),'verifiedMembers':items,'status':'PASS'}
            phase='receipt';s.write_new(result,s.encoded(receipt));receipts.append(receipt)
        except Exception as error:
            try:
                retained=s.read_file(path) if path.exists() else b''
                failure={'url':source['originalWheel']['url'],'range':{k:part[k]for k in ('start','end')},'actualReceivedBytes':size,'receivedSha256':h.hexdigest(),'retainedBytes':len(retained),'retainedSha256':s.digest(retained),'verifiedMembers':items,'phase':phase,'status':'FAIL','error':str(error),'retries':0}
                if not result.exists():s.write_new(result,s.encoded(failure))
            except Exception as storage_error:error.add_note('R55 failure receipt could not persist: '+str(storage_error))
            raise
    s.write_new(private/'ort-acquisition.json',s.encoded({'ranges':receipts,'actualReceivedBytes':received,'wholeWheelAcquired':False,'wholeWheelSha256Verified':False,
      'originalWheelPublisherSha256':source['originalWheel']['sha256'],'originalRecordSha256':source['originalRecordSha256'],'selectedMemberCount':len(source['selectedMembers']),
      'modelBodiesReceived':0,'excludedModelMembers':source['excludedD2Members'],'uniqueOfficialSourceArtifacts':1,'boundedRangeArtifacts':len(receipts)}))
    return {'actualReceivedBytes':received,'rangeArtifacts':len(receipts)}
