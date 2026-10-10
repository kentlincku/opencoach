"""Audited startup guard for the dedicated build venv, never shipped at runtime."""
import os
import sys
from pathlib import Path
import sysconfig
import contextlib
import threading
import re
import stat
sys.dont_write_bytecode = True
install_writes=None
def install_name_arguments(argv,build_root):
    if not build_root or len(argv)<4:raise RuntimeError('R55_INSTALL_NAME_AUTHORITY')
    root=Path(build_root).absolute();target=Path(argv[-1]).absolute()
    if root.parent!=Path(os.environ.get('R55_CANONICAL_PRIVATE','/invalid-canonical-root')) or not re.fullmatch(r'build-output-[0-9]{3}',root.name):raise RuntimeError('R55_INSTALL_NAME_AUTHORITY')
    if not str(argv[-1]).startswith('/') or target.resolve(strict=True)!=target or root.resolve(strict=True)!=root or root not in target.parents or not stat.S_ISREG(target.lstat().st_mode) or target.lstat().st_nlink!=1:raise RuntimeError('R55_INSTALL_NAME_OUTPUT_SCOPE')
    index=1;seen_id=False
    def bounded(value):
        return isinstance(value,str) and 0<len(value)<=4096 and not value.startswith('-') and all(32<=ord(x)<127 for x in value)
    def name(value):return bounded(value) and re.fullmatch(r'@rpath/[A-Za-z0-9_+.-]+',value) is not None
    def rpath(value):return bounded(value) and re.fullmatch(r'@loader_path(?:/(?:\.\.|[A-Za-z0-9_+.-]+))*/*',value) is not None
    while index<len(argv)-1:
        option=argv[index];count={'-id':1,'-change':2,'-delete_rpath':1,'-add_rpath':1}.get(option)
        if count is None or index+count>=len(argv)-1:raise RuntimeError('R55_INSTALL_NAME_ARGV')
        values=argv[index+1:index+1+count]
        if not all(bounded(v) for v in values):raise RuntimeError('R55_INSTALL_NAME_VALUE')
        if option=='-id':
            if seen_id or not name(values[0]):raise RuntimeError('R55_INSTALL_NAME_VALUE')
            seen_id=True
        elif option=='-change' and not name(values[1]):raise RuntimeError('R55_INSTALL_NAME_VALUE')
        elif option=='-add_rpath' and not rpath(values[0]):raise RuntimeError('R55_INSTALL_NAME_VALUE')
        index+=count+1
    if index!=len(argv)-1:raise RuntimeError('R55_INSTALL_NAME_ARGV')
inventory_state=threading.local()
@contextlib.contextmanager
def inventory_hashes(paths,reader):
    # The only exception returns hashes, not resource bytes. Bind the exact
    # reviewed validator frame; collect=True and all package consumers deny.
    site=Path(sysconfig.get_path('purelib')).resolve(strict=False)
    approved=frozenset(os.path.abspath(p) for p in paths)
    if getattr(inventory_state,'grant',None) is not None or reader.__name__!='read_checked' or Path(reader.__code__.co_filename).name!='windows_bundle.py':raise RuntimeError('R55_INVENTORY_AUTHORITY')
    for p in approved:
        try:relative=Path(p).relative_to(site)
        except ValueError:raise RuntimeError('R55_INVENTORY_SCOPE')
        if relative.parts[0] not in ('numpy','scipy') or not p.endswith('.npz') or str(Path(p).resolve(strict=False))!=p:raise RuntimeError('R55_INVENTORY_SCOPE')
    inventory_state.grant=(approved,reader.__code__)
    try:yield
    finally:inventory_state.grant=None
def admit_install_writes(paths):
    global install_writes
    site=Path(sysconfig.get_path('purelib')).absolute()
    if install_writes is not None or os.environ.get('R55_BUILD_OUTPUT') or sys.prefix==sys.base_prefix or sys.flags.isolated!=1:
        raise RuntimeError('R55_INSTALL_WRITE_AUTHORITY')
    if any(site not in Path(p).absolute().parents for p in paths):raise RuntimeError('R55_INSTALL_WRITE_SCOPE')
    normalized={os.path.abspath(p) for p in paths}
    if any(str(Path(p).resolve(strict=False))!=p or site.resolve(strict=False) not in Path(p).parents for p in normalized):raise RuntimeError('R55_INSTALL_WRITE_PHYSICAL_SCOPE')
    install_writes=frozenset(normalized)

def audit(event, args):
    if event in ('os.system','os.posix_spawn','os.fork','pty.spawn'):
        raise RuntimeError('R55_BUILD_UNKNOWN_CHILD')
    if event in ('socket.connect','socket.getaddrinfo','socket.bind'):
        raise RuntimeError('R55_BUILD_NETWORK_FORBIDDEN')
    if event == 'open' and isinstance(args[0], (str,bytes)):
        p=os.fsdecode(args[0]).replace('\\','/')
        if p.endswith(('.safetensors','.tiktoken','.onnx','.npz')) or '/resources/spacy/' in p or '/resources/misaki/' in p or p.endswith('/voices.bin'):
            grant=getattr(inventory_state,'grant',None);frame=sys._getframe(1)
            if grant and frame.f_code is grant[1] and frame.f_locals.get('collect') is False and len(args)>2 and (args[2]&os.O_ACCMODE)==os.O_RDONLY and os.path.abspath(p) in grant[0] and str(Path(p).resolve(strict=False))==os.path.abspath(p):return
            writing=len(args)>2 and (args[2] & os.O_ACCMODE)==os.O_WRONLY and (args[1] is None or args[1] in ('w','wb','a','ab','x','xb'))
            if not writing or install_writes is None or os.path.abspath(p) not in install_writes or str(Path(p).resolve(strict=False))!=os.path.abspath(p):raise RuntimeError('R55_BUILD_D2_READ_FORBIDDEN')
    if event == 'subprocess.Popen':
        executable, argv, cwd, env = args
        executable=os.fsdecode(executable)
        if not isinstance(argv,(list,tuple)) or argv[0]!=executable:raise RuntimeError('R55_TOOL_ARGV')
        if not executable.startswith('/') and (env or os.environ).get('PATH')!='/usr/bin:/bin:/usr/sbin:/sbin':raise RuntimeError('R55_TOOL_PATH')
        # PyInstaller's own hash-bound analysis workers plus existing Apple ABI
        # and adhoc binary signing tools. No shell, remote script or model CLI.
        build_root=os.environ.get('R55_BUILD_OUTPUT')
        def within(file,roots):
            candidate=Path(file).absolute()
            return any(candidate==root or root in candidate.parents for root in roots)
        if executable in ('otool','/usr/bin/otool','lipo','/usr/bin/lipo','codesign','/usr/bin/codesign'):
            if not build_root:raise RuntimeError('R55_TOOL_OUTPUT_AUTHORITY')
            output=Path(build_root)
            roots=[output,Path(sys.prefix),Path(sys.base_prefix),Path('/usr/lib'),Path('/System/Library')]
            operands=[x for x in argv[1:] if isinstance(x,str) and x.startswith('/')]
            if not operands or any(not within(x,roots) for x in operands):raise RuntimeError('R55_TOOL_FILE_SCOPE')
            if executable.endswith('codesign') and not within(argv[-1],[output]):raise RuntimeError('R55_SIGNING_OUTPUT_SCOPE')
            if executable.endswith('lipo') and '-output' in argv and not within(argv[argv.index('-output')+1],[output]):raise RuntimeError('R55_LIPO_OUTPUT_SCOPE')
        child_script=str(Path(sysconfig.get_path('purelib'))/'PyInstaller/isolated/_child.py')
        if executable in ('arch','/usr/bin/arch'):
            if not (len(argv)==6 and argv[1]=='-arm64' and argv[2]==sys.executable and argv[3]==child_script and all(str(x).isdigit() for x in argv[4:]) and env and env.get('R55_BUILD_GUARD')=='1'):
                raise RuntimeError('R55_BUILD_UNKNOWN_CHILD')
        elif executable == sys.executable:
            script=str(Path(sysconfig.get_path('purelib'))/'PyInstaller/isolated/_child.py')
            isolated=isinstance(argv,(list,tuple)) and len(argv)==5 and argv[1]=='-I' and argv[2]==script and all(str(x).isdigit() for x in argv[3:])
            if not isolated or not env or env.get('R55_BUILD_GUARD')!='1':
                raise RuntimeError('R55_BUILD_UNKNOWN_CHILD')
        elif executable=='/usr/bin/git' and list(argv[1:]) in (['rev-parse','HEAD'],['rev-parse','--path-format=absolute','--git-common-dir']):
            pass
        elif executable in ('/usr/bin/otool','otool') and len(argv)==3 and argv[1] in ('-l','-L','-hv'):
            pass
        elif executable in ('/usr/bin/lipo','lipo') and ((len(argv)==3 and argv[1]=='-archs') or (len(argv)==6 and argv[1]=='-thin' and argv[2]=='arm64' and argv[4]=='-output')):
            pass
        elif executable=='/usr/bin/codesign' and list(argv[1:3])==['--remove','--all-architectures'] and len(argv)==4:
            pass
        elif executable in ('/usr/bin/codesign','codesign') and len(argv)>=4 and argv[1:3] in (['-s','-'],['--sign','-']) and all(x in ('--force','--all-architectures','--timestamp=none','--timestamp') for x in argv[3:-1]):
            pass
        elif executable=='/usr/bin/xcrun' and list(argv[1:]) in (['--show-sdk-path'],['--find','otool'],['--find','lipo'],['--find','codesign']):
            pass
        elif executable in ('install_name_tool','/usr/bin/install_name_tool'):
            install_name_arguments(argv,build_root)
        else:
            raise RuntimeError('R55_BUILD_UNKNOWN_CHILD')

if os.environ.get('R55_BUILD_GUARD') == '1':
    sys.addaudithook(audit)
    import r55_tool_custody
    r55_tool_custody.enable()
