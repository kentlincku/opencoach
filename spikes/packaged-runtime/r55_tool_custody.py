"""Original Popen custody for audited build tools; no PID/group operations."""
import atexit
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import _thread
import time

original = subprocess.Popen
records=[]
revoked=False
sequence=0
unknown=False

class OwnedPopen(original):
    def __init__(self,*args,**kwargs):
        if revoked:raise RuntimeError('R55_TOOL_DISPATCH_REVOKED')
        record={'handle':self,'argv':args[0] if args else kwargs.get('args'),'started':False,'noSpawn':False,'drained':{}}
        records.append(record)
        try:
            super().__init__(*args,**kwargs)
            record['started']=True
            record['drained']={k:getattr(self,k) is None for k in ('stdout','stderr')}
        except BaseException:
            record['started']=bool(getattr(self,'_child_created',False))
            record['noSpawn']=not record['started']
            raise

    def communicate(self,*args,**kwargs):
        value=super().communicate(*args,**kwargs)
        record=next(r for r in records if r['handle'] is self)
        record['drained']={'stdout':True,'stderr':True}
        return value
    def record_drain(self,key):
        next(r for r in records if r['handle'] is self)['drained'][key]=True

def enable():
    subprocess.Popen=OwnedPopen

def close_originals(deadline):
    global revoked
    revoked=True
    live=[r for r in records if r['started'] and r['handle'].poll() is None]
    for r in reversed(live):
        try:r['handle'].terminate()
        except ProcessLookupError:pass
    term_end=min(deadline-3,time.monotonic()+2)
    while live and time.monotonic()<term_end:
        live=[r for r in live if r['handle'].poll() is None];time.sleep(.01)
    for r in reversed(live):
        try:r['handle'].kill()
        except ProcessLookupError:pass
    while live and time.monotonic()<deadline:
        live=[r for r in live if r['handle'].poll() is None];time.sleep(.01)
    # A trusted tool may have used communicate or an explicit EOF reader. For
    # unread owned pipes, drain only these original descriptors within deadline.
    import selectors
    selector=selectors.DefaultSelector()
    for r in records:
        if not r['started']:continue
        for key in ('stdout','stderr'):
            stream=getattr(r['handle'],key,None)
            if r['drained'].get(key):continue
            if stream is None:r['drained'][key]=True
            elif not stream.closed:
                os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ,(r,key))
    while selector.get_map() and time.monotonic()<deadline:
        for event,_ in selector.select(min(.01,max(0,deadline-time.monotonic()))):
            try:block=os.read(event.fd,65536)
            except BlockingIOError:continue
            if not block:
                r,key=event.data;r['drained'][key]=True;selector.unregister(event.fileobj)
    selector.close()
    closed=not live and all(r['noSpawn'] or (r['started'] and all(r['drained'].get(k,False) for k in ('stdout','stderr'))) for r in records)
    for r in records:
        if not r['started'] or r['handle'].poll() is None:continue
        p=r['handle']
        # Trusted tool owners have already consumed their bounded outputs. At
        # cleanup, reap precedes final descriptor close; no numeric PID lookup.
        p.wait(timeout=0)
        for stream in (p.stdin,p.stdout,p.stderr):
            if stream is not None and not stream.closed:stream.close()
    return closed

def projection():
    return [{'argv':r['argv'],'pid':getattr(r['handle'],'pid',None),'noSpawn':r['noSpawn'],
             'reaped':r['started'] and r['handle'].poll() is not None,
             'exit':getattr(r['handle'],'returncode',None),'drained':r['drained']} for r in records]

def write_receipt(path,raw):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        remaining=memoryview(raw)
        while remaining:
            count=os.write(fd,remaining)
            if count<=0:raise RuntimeError('R55_TOOL_RECEIPT_SHORT_WRITE')
            remaining=remaining[count:]
        os.fsync(fd)
    finally:os.close(fd)
    directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(directory)
    finally:os.close(directory)
    if path.read_bytes()!=raw:raise RuntimeError('R55_TOOL_RECEIPT_READBACK')

def persist(label,closed):
    global sequence
    folder=os.environ.get('R55_TOOL_RECEIPTS')
    if not folder:return
    sequence+=1
    path=Path(folder)/f'{label}-{os.getpid()}-{sequence}.json'
    raw=(json.dumps({'closure':'CLOSED' if closed and not unknown else 'UNKNOWN','children':projection()},sort_keys=True,indent=2)+'\n').encode()
    write_receipt(path,raw)

def retain_originals():
    # Receipt failure must never discard original live handle responsibility.
    while any(r['started'] and r['handle'].poll() is None for r in records):time.sleep(.05)

def finalize(deadline,label):
    global revoked,unknown
    closed=False;failure=None
    try:closed=close_originals(deadline)
    except BaseException as error:failure=error
    if not closed:
        unknown=True;revoked=True
    try:
        if not closed:
            path=Path(os.environ['R55_CANONICAL_PRIVATE'])/f'infrastructure-tool-{os.getpid()}-unknown.json'
            if not path.exists():write_receipt(path,(json.dumps({'closure':'UNKNOWN','children':projection()},sort_keys=True)+'\n').encode())
        persist(label,closed)
    except BaseException as error:failure=error
    finally:
        if not closed:retain_originals()
    if failure:raise failure
    if not closed:raise RuntimeError('R55_TOOL_CLOSURE_UNKNOWN')
    if not unknown:revoked=False

def supervise(call,seconds):
    global revoked
    if unknown:raise RuntimeError('R55_STICKY_TOOL_UNKNOWN')
    revoked=False;enable()
    deadline=time.monotonic()+seconds
    timer=threading.Timer(max(0,seconds-5),_thread.interrupt_main)
    timer.daemon=True;timer.start()
    try:return call()
    finally:
        timer.cancel()
        finalize(deadline,'supervision')

def terminal():
    try:finalize(time.monotonic()+5,'terminal')
    except BaseException:
        # No later dispatch exists at terminal; handle retention still executed.
        retain_originals()

atexit.register(terminal)
