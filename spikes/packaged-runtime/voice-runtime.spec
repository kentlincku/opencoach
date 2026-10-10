# Run through build-runtime.py; the Windows branch independently repeats admission.
from pathlib import Path
import platform
import sys

root = Path(SPECPATH).parents[1]
if platform.system() == 'Windows':
    import argparse
    sys.path.insert(0, str(SPECPATH))
    import windows_bundle
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--bundle-sha256', required=True)
    parser.add_argument('--wheelhouse', type=Path, required=True)
    parser.add_argument('--prepared', type=Path, required=True)
    args = parser.parse_args()
    windows_bundle.require_native()
    plan = windows_bundle.verify_prepared(args.bundle, args.bundle_sha256, args.wheelhouse, args.prepared)
    windows_bundle.verify_installed(plan)
    from PyInstaller.utils.hooks import collect_data_files
    plan['datas'] += collect_data_files('inflect', include_py_files=True)
    a = Analysis([str(root / 'native/python/voice_runtime/server.py')],
                 pathex=[plan['source'], str(root / 'native/python')],
                 hiddenimports=plan['hiddenimports'], datas=plan['datas'],
                 excludes=plan['excludes'], runtime_hooks=[str(Path(SPECPATH) / 'pyi_rth_native_alias.py')],
                 noarchive=True)
    windows_bundle.validate_collection(a, plan)
    pyz = PYZ(a.pure)
    exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='voice-runtime',
              console=True, contents_directory='_internal', upx=False)
    coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='voice-runtime')
else:
    import argparse
    import json
    sys.path.insert(0, str(SPECPATH))
    import darwin_bundle
    parser=argparse.ArgumentParser()
    parser.add_argument('--darwin-wheelhouse',type=Path,required=True)
    parser.add_argument('--darwin-installation',type=Path,required=True)
    parser.add_argument('--darwin-mode',choices=['engineering','production'],required=True)
    parser.add_argument('--darwin-output',type=Path,required=True)
    args=parser.parse_args()
    darwin_bundle.require_native();code,source_gate=darwin_bundle.reviewed_source()
    plan=darwin_bundle.plan(args.darwin_wheelhouse,args.darwin_installation,args.darwin_mode)
    a = Analysis([str(Path(SPECPATH)/'darwin-entry.py')],pathex=[str(root/'native/python')],
       hiddenimports=plan['hiddenimports'],datas=plan['datas'],excludes=plan['excludes'],
       hookspath=[str(Path(SPECPATH)/'darwin-hooks')])
    collection=darwin_bundle.validate_collection(a,plan,args.darwin_output,source_gate.get('existingPythonSharedLibrary'))
    darwin_bundle.support.write_new(args.darwin_output/'collection.json',darwin_bundle.support.encoded(collection))
    pyz = PYZ(a.pure)
    exe = EXE(pyz,a.scripts,[],exclude_binaries=True,name='voice-runtime',console=True,
              contents_directory='_internal',target_arch='arm64',upx=False)
    coll = COLLECT(exe,a.binaries,a.datas,strip=False,upx=False,name='bin')
