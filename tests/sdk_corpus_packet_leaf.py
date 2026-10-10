"""Finite unavailable-host leaves for real packet Bash tests; NOT receipts."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

args = sys.argv[1:]
assert args[:3] == ['-I', '-S', '-B']
script = Path(args[3]); rest = args[4:]
root = Path(os.environ['PACKET_LEAF_ROOT'])
case = os.environ['PACKET_LEAF_CASE']
original = os.environ['PACKET_LEAF_PYTHON']
if script.name == 'preflight.py':
    assert len(rest) == 2 and rest[0] == original
    with (root / 'preflight-calls').open('ab') as f:
        f.write(b'once\n')
    pre = Path(rest[1])
    public = dict(status='READY_FOR_ONCE_TRIAL02', collector_invocations=0,
                  phase='PREFLIGHT_COMPLETE', same_installation=True, full_version_match=True,
                  architecture_match=True, runtime_executable_nofollow=True, plain_layout_metadata=True)
    runtime = dict(implementation='cpython', version_info=[3, 11, 15, 'final', 0],
                   platform='darwin', machine='arm64', flags=[1, 1, 1], unprivileged=True,
                   executable=original, base_prefix=str(root), prefix=str(root),
                   exec_prefix=str(root), base_exec_prefix=str(root))
    (pre / 'selected-python.txt').write_text(original + ('\n' if case != 'eof' else ''))
    (pre / 'private-metadata.json').write_text(json.dumps(dict(
        selected_entry=original, canonical_runtime=runtime, public=public)))
    print(json.dumps(public))
    raise SystemExit(3 if case == 'preflight-fail' else 0)
if script.name == 'native.py':
    repo, final, private = (os.environ[k] for k in ('PACKET_LEAF_REPO', 'PACKET_LEAF_FINAL', 'PACKET_LEAF_PRIVATE'))
    mapping = Path(private) / 'source-map.json'
    digest = hashlib.sha256(mapping.read_bytes()).hexdigest()
    assert json.loads(mapping.read_bytes())['final'] == final
    assert (Path(repo) / '.git/HEAD').read_text() == final + '\n'
    assert rest == ['capture', '--repo', repo, '--final', final, '--source-map', str(mapping),
                    '--source-map-sha256', digest, '--out', private + '/OUT',
                    '--python', original, '--base-home', str(root)]
    assert not Path(private + '/OUT').exists()
    with (root / 'capture-calls').open('ab') as f:
        f.write(b'once\n')
    Path(private + '/OUT').mkdir(mode=0o700)
    print('SYNTHETIC_LEAF_ONLY_NOT_A_NATIVE_RECEIPT')
    raise SystemExit({'complete': 0, 'partial': 2, 'stop': 2}[case])
if script.name == 'packet.py' and rest[0] == 'export':
    # Only control-flow substitution. No archive/manifest/metadata is fabricated.
    assert len(rest) == 10
    assert Path(rest[5]).read_text() == str({'complete': 0, 'partial': 2, 'stop': 2}[case]) + '\n'
    with (root / 'export-calls').open('ab') as f:
        f.write(b'once\n')
    raise SystemExit(3 if case == 'stop' else 0)
assert script.name == 'packet.py' and rest[0] in ('map', 'controls')
raise SystemExit(subprocess.run([sys.executable, *args], timeout=15).returncode)
