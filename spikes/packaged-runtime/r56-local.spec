# R56 local (single-machine) Darwin build. Same entry, hidden imports, hooks and
# installed R55 environment as voice-runtime.spec; the R55 admission ceremony is
# replaced by an explicit input manifest checked by scripts/r56-build-local-runtime.py.
import json, os, sys
from pathlib import Path
sys.path.insert(0, str(SPECPATH))
import darwin_bundle as db
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

cfg = json.loads(Path(os.environ['R56_BUILD_PLAN']).read_text())
root = Path(SPECPATH).parents[1]
# R56: langcodes data modules are now supplied (D2 gap closed), so stop excluding them.
excludes = [e for e in db.EXCLUDES if e not in ('langcodes.data_dicts',)] + ['numba', 'llvmlite', 'scipy']
a = Analysis([str(Path(SPECPATH) / 'darwin-entry.py')],
             pathex=[cfg['overlay'], str(root / 'native/python'), str(Path(SPECPATH))],
             hiddenimports=db.HIDDEN + ['packaged_stubs', 'langcodes.data_dicts', 'langcodes.language_lists', 'spacy_legacy', 'spacy_loggers'] + collect_submodules('mlx'),
             datas=[tuple(x) for x in cfg['datas']] + collect_data_files('spacy', excludes=['**/tests/**']), excludes=excludes,
             hookspath=[str(Path(SPECPATH) / 'darwin-hooks')],
             module_collection_mode={'inflect': 'pyz+py'})
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='voice-runtime', console=True,
          contents_directory='_internal', target_arch='arm64', upx=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='bin')
