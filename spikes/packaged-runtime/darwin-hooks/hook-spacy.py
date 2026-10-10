"""Static English code closure. No import of spaCy or D2 language resources."""
from pathlib import Path
import sysconfig
from PyInstaller.utils.hooks import collect_dynamic_libs
root=Path(sysconfig.get_path('purelib'))/'spacy'
hiddenimports=[]
for file in root.rglob('*'):
    if not file.is_file():continue
    relative=file.relative_to(root);parts=relative.parts
    if any(p in ('tests','cli','training') for p in parts):continue
    if parts[0]=='lang' and len(parts)>1 and parts[1] not in ('en','__init__.py','char_classes.py','lex_attrs.py','norm_exceptions.py','punctuation.py','tokenizer_exceptions.py'):
        continue
    if file.suffix=='.py':
        name='spacy.'+'.'.join(relative.with_suffix('').parts)
        hiddenimports.append(name.removesuffix('.__init__'))
    elif file.suffix=='.so':hiddenimports.append('spacy.'+'.'.join(parts[:-1]+(parts[-1].split('.')[0],)))
binaries=collect_dynamic_libs('spacy')
datas=[]
for file in root.rglob('*'):
    if file.is_file() and file.suffix in ('.cfg','.json') and not any(p in ('tests','cli','training','lang') for p in file.relative_to(root).parts):
        datas.append((str(file),str(Path('spacy')/file.relative_to(root).parent)))
