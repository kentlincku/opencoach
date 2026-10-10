"""Tooling unit fixtures only: NOT a frozen runtime, signature or App acceptance."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
from contextlib import redirect_stderr
import tempfile
import unittest
from unittest import mock
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/macos-stage-model-packs.py'
FIXTURE_COMMIT = '1' * 40


class StageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='model-packs-stage-', dir=os.environ['TMPDIR'])
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.build = self.base / 'build-fixture'
        self.runtime = self.build / 'dist/runtime'
        self.payloads = {
            'bin/voice-runtime': b'NON_NATIVE_TEST_FIXTURE_NOT_EXECUTABLE',
            'bin/_internal/voice_practice_speech_vendor/resources/misaki/en/us_gold.json': b'{}',
            'bin/_internal/voice_practice_speech_vendor/resources/spacy/en_core_web_sm/tokenizer': b'G2P fixture',
            'bin/_internal/langcodes/data/language-subtag-registry.txt': b'dictionary fixture',
        }
        for rel, data in self.payloads.items():
            p = self.runtime / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        self.receipt = {'class': 'R56_LOCAL_SINGLE_MACHINE_NOT_RELEASE', 'commit': FIXTURE_COMMIT,
                        'acquisition': hashlib.sha256(b'fixture acquisition').hexdigest(),
                        'langcodes': {}, 'nonPortableNames': [], 'symlinks': [],
                        'fileCount': len(self.payloads), 'treeSha256': self.tree_sha()}
        self.write_receipt()

    def tree_sha(self):
        files = {p.relative_to(self.runtime).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in sorted(self.runtime.rglob('*')) if p.is_file() and not p.is_symlink()}
        return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()

    def write_receipt(self):
        (self.build / 'receipt.json').write_text(json.dumps(self.receipt) + '\n')

    def module(self):
        self.assertTrue(SCRIPT.is_file(), 'runtime-only stage tool must exist')
        spec = importlib.util.spec_from_file_location('macos_stage_model_packs', SCRIPT)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_cli_is_explicit_and_refuses_unknown_or_missing_arguments(self):
        result = subprocess.run(['python3', '-B', str(SCRIPT), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('--runtime-build', result.stdout)
        self.assertIn('--acquisition', result.stdout)
        self.assertIn('--output', result.stdout)
        for argv in [[], ['--allow-dirty'], ['--skip-sign']]:
            result = subprocess.run(['python3', '-B', str(SCRIPT), *argv], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)

    def test_stage_rejects_dirty_source_before_creating_output(self):
        stage = self.module()
        out = self.base / 'no-output'
        with mock.patch.object(stage, 'source_snapshot', side_effect=ValueError('MODEL_PACK_SOURCE_DIRTY')):
            with self.assertRaisesRegex(ValueError, 'SOURCE_DIRTY'):
                stage.stage(self.build, self.base / 'acquisition', out)
        self.assertFalse(out.exists())

    def filesystem_snapshot(self, root):
        """Record actual entries/identities/modes/bytes, without following links."""
        result = {}
        for p in [root, *sorted(root.rglob('*'))]:
            st = p.lstat()
            result[p.relative_to(root).as_posix()] = (
                st.st_dev, st.st_ino, st.st_mode, st.st_nlink, st.st_mtime_ns,
                p.read_bytes() if stat.S_ISREG(st.st_mode) else
                os.readlink(p) if stat.S_ISLNK(st.st_mode) else None)
        return result

    def test_cli_rejects_noncanonical_tokens_without_writes(self):
        """Real CLI parser/filesystem; source/acquisition/sign boundary doubles."""
        stage = self.module()
        acquisition = self.base / 'acquisition'
        acquisition.mkdir()
        source = {'commit': FIXTURE_COMMIT, 'gitTree': '2' * 40, 'treeSha256': '3' * 64, 'files': []}
        spellings = {
            'dot': lambda p: str(p.parent) + '/./' + p.name,
            'repeated': lambda p: str(p.parent) + '//' + p.name,
            'double-leading': lambda p: '/' + str(p),
            'trailing': lambda p: str(p) + '/',
        }
        self.addCleanup(os.umask, os.umask(0o077))
        for flag in ['--runtime-build', '--acquisition', '--output']:
            for name, spelling in spellings.items():
                with self.subTest(flag=flag, spelling=name):
                    # For output, the accepted alias would write INSIDE readonly input.
                    out = (self.build if flag == '--output' else self.base) / ('fresh-' + flag[2:] + '-' + name)
                    values = {'--runtime-build': str(self.build), '--acquisition': str(acquisition), '--output': str(out)}
                    values[flag] = spelling(Path(values[flag]))
                    before = {p: self.filesystem_snapshot(p) for p in [self.build, acquisition]}
                    stderr = io.StringIO()
                    with mock.patch.object(stage, 'source_snapshot', return_value=source) as source_boundary, \
                            mock.patch.object(stage, 'verify_acquisition', return_value={}), \
                            mock.patch.object(stage, 'sign_runtime', side_effect=ValueError('NON_NATIVE_SIGN_BOUNDARY')), \
                            redirect_stderr(stderr):
                        result = stage.main([part for pair in values.items() for part in pair])
                    self.assertEqual({p: self.filesystem_snapshot(p) for p in before}, before)
                    self.assertFalse(out.exists(), 'invalid spelling must not create any output')
                    self.assertEqual(result, 1)
                    self.assertIn('MODEL_PACK_STAGE_UNSAFE_PATH', stderr.getvalue())
                    source_boundary.assert_not_called()

    def test_stage_rejects_case_alias_overlap_by_filesystem_identity(self):
        """Case aliases are exercised only when the fixture filesystem supports them."""
        stage = self.module()
        source_root = self.base / 'source-fixture'
        acquisition = self.base / 'acquisition'
        acquisition.mkdir()
        (source_root / 'resources').mkdir(parents=True)
        (source_root / 'build').mkdir()
        (source_root / 'resources/macos-model-packs.json').write_bytes((ROOT / 'resources/macos-model-packs.json').read_bytes())
        (source_root / 'build/entitlements.runtime.plist').write_bytes((ROOT / 'build/entitlements.runtime.plist').read_bytes())
        inputs = {'source': source_root, 'runtime': self.build, 'acquisition': acquisition}
        alias = lambda p: p.with_name(p.name.upper())
        if not all(alias(p).exists() and os.path.samefile(p, alias(p)) for p in [*inputs.values(), self.base]):
            self.skipTest('fixture filesystem is case-sensitive; no case alias is available')
        source = {'commit': FIXTURE_COMMIT, 'gitTree': '2' * 40, 'treeSha256': '3' * 64, 'files': []}
        for role, readonly in inputs.items():
            for relation in ['descendant', 'equal', 'ancestor', 'aliased-input']:
                with self.subTest(input=role, relation=relation):
                    roots = inputs.copy()
                    if relation == 'aliased-input':
                        roots[role] = alias(readonly)
                        out = readonly / 'fresh-canonical-child'
                    elif relation == 'descendant':
                        out = alias(readonly) / 'fresh-aliased-child'
                    else:
                        out = alias(readonly if relation == 'equal' else self.base)
                    before = {p: self.filesystem_snapshot(p) for p in inputs.values()}
                    error = None
                    with mock.patch.object(stage, 'ROOT', roots['source']), \
                            mock.patch.object(stage, 'source_snapshot', return_value=source) as source_boundary, \
                            mock.patch.object(stage, 'verify_acquisition', return_value={}), \
                            mock.patch.object(stage, 'sign_runtime', side_effect=ValueError('NON_NATIVE_SIGN_BOUNDARY')):
                        try:
                            stage.stage(roots['runtime'], roots['acquisition'], out)
                        except (ValueError, OSError) as caught:
                            error = caught
                    self.assertEqual({p: self.filesystem_snapshot(p) for p in before}, before)
                    self.assertRegex(str(error), 'MODEL_PACK_STAGE_OUTPUT_OVERLAPS_INPUT')
                    source_boundary.assert_not_called()

    def test_stage_sign_failure_leaves_private_failure_not_success_receipt(self):
        stage = self.module()
        out = self.base / 'failed-stage'
        source = {'commit': FIXTURE_COMMIT, 'gitTree': '2' * 40, 'treeSha256': '3' * 64, 'files': []}
        with mock.patch.object(stage, 'source_snapshot', return_value=source), \
                mock.patch.object(stage, 'verify_acquisition', return_value={}), \
                mock.patch.object(stage, 'sign_runtime', side_effect=ValueError('SIGN_COMMAND_FAILED')):
            with self.assertRaisesRegex(ValueError, 'SIGN_COMMAND_FAILED'):
                stage.stage(self.build, self.base / 'acquisition', out)
        self.assertFalse((out / 'receipt.json').exists())
        self.assertEqual(json.loads((out / 'failure.json').read_text())['status'], 'FAILED')
        self.assertEqual((out / 'failure.json').stat().st_mode & 0o777, 0o600)

    def test_stage_pipeline_writes_post_sign_trust_and_external_manifests_only(self):
        """Source/signature boundaries doubled. Output is NOT native acceptance."""
        stage = self.module()
        self.assertTrue(hasattr(stage, 'stage'), 'full runtime-only stage pipeline is required')
        out = self.base / 'staged'
        source = {'commit': FIXTURE_COMMIT, 'gitTree': '2' * 40, 'treeSha256': '3' * 64, 'files': []}
        acquisition = {'path': str(self.base / 'acquire-fixture'), 'manifestSha256': self.receipt['acquisition'], 'files': []}
        events = []
        entry = self.runtime / 'bin/voice-runtime'
        entry.chmod(0o700)
        input_before = self.filesystem_snapshot(self.build)
        receipt_bytes = (self.build / 'receipt.json').read_bytes()

        def sign_boundary(assets, identity, entitlements):
            events.append('sign')
            staged_entry = assets / 'runtime/bin/voice-runtime'
            staged_entry.write_bytes(staged_entry.read_bytes() + b'NON_NATIVE_SIGNING_BOUNDARY')
            return {'status': 'PASS', 'identity': identity, 'entitlementsSha256': hashlib.sha256(entitlements.read_bytes()).hexdigest(),
                    'files': ['runtime/bin/voice-runtime'], 'commands': []}

        original_trust = (ROOT / 'apps/desktop/bundled-voice-trust.cjs').read_bytes()
        with mock.patch.object(stage, 'source_snapshot', return_value=source) as source_boundary, \
                mock.patch.object(stage, 'verify_acquisition', return_value=acquisition) as acquisition_boundary, \
                mock.patch.object(stage, 'verify_runtime', wraps=stage.verify_runtime) as runtime_verifier, \
                mock.patch.object(stage, 'sign_runtime', side_effect=sign_boundary), \
                mock.patch.dict(os.environ, {'R56_SIGN_IDENTITY': 'TEST_BOUNDARY_IDENTITY'}):
            result = stage.stage(self.build, self.base / 'acquire-fixture', out)
        self.assertEqual(events, ['sign'])
        self.assertEqual(source_boundary.call_count, 2)
        self.assertEqual(acquisition_boundary.call_count, 2)
        self.assertEqual(runtime_verifier.call_count, 2)
        self.assertEqual(self.filesystem_snapshot(self.build), input_before)
        receipt = json.loads((out / 'receipt.json').read_text())
        self.assertEqual(receipt['runtimeInput']['receiptSha256'], hashlib.sha256(receipt_bytes).hexdigest())
        self.assertEqual(result['receiptSha256'], hashlib.sha256((out / 'receipt.json').read_bytes()).hexdigest())
        self.assertEqual(receipt['source']['commit'], FIXTURE_COMMIT)
        trust = json.loads((out / 'trust.json').read_text())
        self.assertEqual(trust['schemaVersion'], 2)
        self.assertEqual(trust['mode'], 'runtime-only')
        self.assertEqual(trust['fileCount'], len(self.payloads))
        inv = json.loads((out / 'resources/voice-assets-inventory.json').read_text())['files']
        entry_record = next(f for f in inv if f['path'] == 'runtime/bin/voice-runtime')
        self.assertEqual(entry_record['sha256'], hashlib.sha256((out / 'resources/voice-assets/runtime/bin/voice-runtime').read_bytes()).hexdigest())
        self.assertNotEqual(entry_record['sha256'], hashlib.sha256(entry.read_bytes()).hexdigest())
        bundle = json.loads((ROOT / 'resources/macos-model-packs.json').read_text())
        self.assertEqual(json.loads((out / 'resources/manifests/model-manifest.json').read_text()), bundle['modelManifest'])
        self.assertEqual(json.loads((out / 'resources/manifests/speech-model-capabilities.json').read_text()), bundle['capabilities'])
        self.assertEqual((out / 'resources/manifests/runtime-manifest.json').read_bytes(), (ROOT / 'resources/runtime-manifest.json').read_bytes())
        self.assertFalse((out / 'resources/manifests/macos-model-packs.json').exists())
        self.assertFalse((out / 'resources/voice-assets/models').exists())
        self.assertEqual((ROOT / 'apps/desktop/bundled-voice-trust.cjs').read_bytes(), original_trust)
        for f in receipt['files']:
            file = out / f['path']
            self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(), f['sha256'])
            self.assertEqual(file.stat().st_mode & 0o077, 0)
        self.assertEqual((out / 'receipt.json').stat().st_mode & 0o777, 0o600)

    def test_acquisition_closure_rehashes_manifest_resources_and_langcodes(self):
        stage = self.module()
        self.assertTrue(hasattr(stage, 'verify_acquisition'), 'R56 acquisition closure must be rechecked')
        acq = self.base / 'acquire'
        acq.mkdir()
        (acq / 'resource.bin').write_bytes(b'NON_NATIVE_RESOURCE_FIXTURE')
        (acq / 'language_lists.py').write_bytes(b'# dictionary fixture')
        manifest = {'schemaVersion': 1, 'files': [{'path': 'resource.bin',
                    'bytes': (acq / 'resource.bin').stat().st_size,
                    'sha256': hashlib.sha256((acq / 'resource.bin').read_bytes()).hexdigest()}]}
        (acq / 'acquisition.json').write_text(json.dumps(manifest))
        receipt = {**self.receipt, 'acquisition': hashlib.sha256((acq / 'acquisition.json').read_bytes()).hexdigest(),
                   'langcodes': {'language_lists.py': hashlib.sha256((acq / 'language_lists.py').read_bytes()).hexdigest()}}
        verified = stage.verify_acquisition(acq, receipt)
        self.assertEqual(verified['manifestSha256'], receipt['acquisition'])
        self.assertEqual({f['path'] for f in verified['files']}, {'resource.bin', 'language_lists.py'})
        (acq / 'language_lists.py').write_bytes(b'drift')
        with self.assertRaisesRegex(ValueError, 'ACQUISITION_FILE_CHANGED'):
            stage.verify_acquisition(acq, receipt)
        (acq / 'acquisition.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'ACQUISITION_MANIFEST_CHANGED'):
            stage.verify_acquisition(acq, receipt)

    def test_receipt_json_cannot_hide_duplicate_keys_or_aliases(self):
        stage = self.module()
        receipt_file = self.build / 'receipt.json'
        receipt_file.write_text('{"commit":"bad",' + json.dumps(self.receipt)[1:])
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_JSON_KEY'):
            stage.verify_runtime(self.build, FIXTURE_COMMIT)
        receipt_file.unlink()
        target = self.base / 'receipt-original.json'
        target.write_text(json.dumps(self.receipt))
        receipt_file.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_LINK'):
            stage.verify_runtime(self.build, FIXTURE_COMMIT)

    def test_signing_boundary_covers_every_macho_before_inventory(self):
        """codesign/lipo are OS-boundary doubles; no native signing is claimed."""
        stage = self.module()
        self.assertTrue(hasattr(stage, 'sign_runtime'), 'required pre-inventory signing boundary')
        magics = [b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xce',
                  b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca']
        assets = self.base / 'assets'
        assets.mkdir()
        entry = assets / 'runtime/bin/voice-runtime'
        entry.parent.mkdir(parents=True)
        entry.write_bytes(magics[0] + b'NON_NATIVE_ENTRY')
        entry.chmod(0o700)
        libraries = []
        for index, magic in enumerate(magics):
            library = entry.parent / ('fixture-%d.dylib' % index)
            library.write_bytes(magic + b'NOT_A_REAL_MACHO')
            libraries.append(library)
        entitlements = self.base / 'entitlements.plist'
        entitlements.write_bytes(b'NON_NATIVE_ENTITLEMENTS_FIXTURE')
        calls = []

        def fake_run(argv, **kwargs):
            calls.append(argv)
            if '--sign' in argv:
                file = Path(argv[-1])
                file.write_bytes(file.read_bytes() + b'BOUNDARY_DOUBLE_NOT_A_SIGNATURE')
            return subprocess.CompletedProcess(argv, 0, stdout=b'', stderr=b'')

        with mock.patch.object(stage.subprocess, 'run', side_effect=fake_run), \
                mock.patch.object(stage.platform, 'system', return_value='Darwin'), \
                mock.patch.object(stage.platform, 'machine', return_value='arm64'):
            result = stage.sign_runtime(assets, 'TEST_BOUNDARY_IDENTITY', entitlements)
        sign_calls = [argv for argv in calls if '--sign' in argv]
        verify_calls = [argv for argv in calls if '--verify' in argv]
        self.assertEqual({argv[-1] for argv in sign_calls}, {str(p) for p in [entry, *libraries]})
        self.assertEqual(sign_calls[-1][-1], str(entry))
        self.assertEqual(len(verify_calls), len(sign_calls))
        self.assertEqual(len(result['files']), len(sign_calls))
        for argv in sign_calls:
            self.assertIn('--timestamp=none', argv)
            self.assertIn('runtime', argv)
            self.assertEqual('--entitlements' in argv, argv[-1] == str(entry))
        for f in stage.inventory(assets):
            self.assertEqual(f['sha256'], hashlib.sha256((assets / f['path']).read_bytes()).hexdigest())
            self.assertTrue((assets / f['path']).read_bytes().endswith(b'BOUNDARY_DOUBLE_NOT_A_SIGNATURE'))

    def test_missing_identity_or_non_macho_entry_cannot_make_a_signed_stage(self):
        stage = self.module()
        self.assertTrue(hasattr(stage, 'sign_runtime'), 'fail-closed native signing is required')
        assets = self.base / 'assets'
        stage.copy_runtime(stage.verify_runtime(self.build, FIXTURE_COMMIT), assets)
        with self.assertRaisesRegex(ValueError, 'SIGN_IDENTITY_REQUIRED'):
            stage.sign_runtime(assets, '', ROOT / 'build/entitlements.runtime.plist')
        with self.assertRaisesRegex(ValueError, 'MACHO_ENTRY_REQUIRED'):
            stage.sign_runtime(assets, 'TEST_BOUNDARY_IDENTITY', ROOT / 'build/entitlements.runtime.plist')

    def test_adhoc_signing_only_for_explicit_public_build(self):
        stage = self.module()
        assets = self.base / 'assets'
        stage.copy_runtime(stage.verify_runtime(self.build, FIXTURE_COMMIT), assets)
        with mock.patch.dict(os.environ, {'VOICE_PUBLIC_ADHOC_BUILD': ''}):
            with self.assertRaisesRegex(ValueError, 'SIGN_IDENTITY_REQUIRED'):
                stage.sign_runtime(assets, '-', ROOT / 'build/entitlements.runtime.plist')
        entry = assets / 'runtime/bin/voice-runtime'
        entry.write_bytes(bytes.fromhex('cffaedfe') + b'x'); entry.chmod(0o755)
        calls = []
        def fake_run(argv, **kwargs):
            calls.append(argv)
            return mock.Mock(returncode=0, stdout=b'', stderr=b'')
        with mock.patch.dict(os.environ, {'VOICE_PUBLIC_ADHOC_BUILD': '1'}), \
                mock.patch.object(stage.subprocess, 'run', side_effect=fake_run), \
                mock.patch.object(stage.platform, 'system', return_value='Darwin'), \
                mock.patch.object(stage.platform, 'machine', return_value='arm64'):
            result = stage.sign_runtime(assets, '-', ROOT / 'build/entitlements.runtime.plist')
        sign = [argv for argv in calls if '--sign' in argv]
        self.assertTrue(sign)
        self.assertTrue(all('runtime' not in argv and '--entitlements' not in argv for argv in sign))
        self.assertEqual(result['identity'], 'adhoc')

    def test_copy_race_cannot_chmod_an_external_symlink_target(self):
        stage = self.module()
        verified = stage.verify_runtime(self.build, FIXTURE_COMMIT)
        outside = self.base / 'read-only-external-input'
        outside.write_bytes(b'EXTERNAL_FIXTURE_MUST_REMAIN_UNTOUCHED')
        outside.chmod(0o640)
        original_inventory = stage.inventory
        swapped = False

        def race(root):
            nonlocal swapped
            result = original_inventory(root)
            if root == self.runtime and not swapped:
                swapped = True
                entry = self.runtime / 'bin/voice-runtime'
                entry.unlink()
                entry.symlink_to(outside)
            return result

        with mock.patch.object(stage, 'inventory', side_effect=race):
            with self.assertRaises((ValueError, OSError)):
                stage.copy_runtime(verified, self.base / 'raced-assets')
        self.assertEqual(outside.stat().st_mode & 0o777, 0o640)
        self.assertEqual(outside.read_bytes(), b'EXTERNAL_FIXTURE_MUST_REMAIN_UNTOUCHED')

    def test_copy_destination_ancestor_race_never_writes_outside(self):
        """Only the race scheduler is doubled; open/mkdir/copy/chmod are real."""
        stage = self.module()
        verified = stage.verify_runtime(self.build, FIXTURE_COMMIT)
        out = self.base / 'raced-destination'
        outside = self.base / 'outside-destination'
        outside.mkdir(mode=0o750)
        sentinel = outside / 'sentinel'
        sentinel.write_bytes(b'OUTSIDE_BYTES_MUST_NOT_CHANGE')
        sentinel.chmod(0o640)
        before = self.filesystem_snapshot(outside)
        entry = self.runtime / 'bin/voice-runtime'
        entry.chmod(0o755)
        input_before = self.filesystem_snapshot(self.build)
        original_open = os.open
        swapped, opened_fds = False, []

        def race(file, flags, *args, **kwargs):
            nonlocal swapped
            if file == entry and (out / 'runtime/bin').is_dir() and not swapped:
                swapped = True
                (out / 'runtime/bin').rename(out / 'saved-bin')
                (out / 'runtime/bin').symlink_to(outside, target_is_directory=True)
            fd = original_open(file, flags, *args, **kwargs)
            opened_fds.append(fd)
            return fd

        error = None
        with mock.patch.object(stage.os, 'open', side_effect=race):
            try:
                stage.copy_runtime(verified, out)
            except (ValueError, OSError) as caught:
                error = caught
        self.assertTrue(swapped, 'the source-open boundary must actually deliver the race')
        self.assertFalse((outside / 'voice-runtime').exists(), 'rejecting later must not leave an external file')
        self.assertEqual(self.filesystem_snapshot(outside), before, 'no external files, directories, modes or bytes may change')
        self.assertEqual(self.filesystem_snapshot(self.build), input_before)
        self.assertIsNotNone(error, 'the substituted output ancestor must be rejected')
        for fd in set(opened_fds):
            with self.assertRaises(OSError, msg='every descriptor must be closed after rejection'):
                os.fstat(fd)

    def test_copy_rejects_same_bytes_source_inode_swap_before_target_creation(self):
        """No-follow is not an inode check; the scheduler replaces a regular file."""
        stage = self.module()
        verified = stage.verify_runtime(self.build, FIXTURE_COMMIT)
        out = self.base / 'source-identity-output'
        entry = self.runtime / 'bin/voice-runtime'
        saved = self.base / 'saved-source-entry'
        original_bytes, original_mode = entry.read_bytes(), stat.S_IMODE(entry.stat().st_mode)
        original_open = os.open
        swapped = False
        raced_input = None

        def race(file, flags, *args, **kwargs):
            nonlocal swapped, raced_input
            if file == entry and out.exists() and not swapped:
                swapped = True
                entry.rename(saved)
                entry.write_bytes(original_bytes)
                entry.chmod(original_mode)
                raced_input = self.filesystem_snapshot(self.build)
            return original_open(file, flags, *args, **kwargs)

        error = None
        with mock.patch.object(stage.os, 'open', side_effect=race):
            try:
                stage.copy_runtime(verified, out)
            except (ValueError, OSError) as caught:
                error = caught
        self.assertTrue(swapped)
        self.assertFalse((out / 'runtime/bin/voice-runtime').exists(), 'identity drift must be rejected before copying this source')
        self.assertRegex(str(error), 'UNSAFE_FILE_CHANGED')
        self.assertEqual(self.filesystem_snapshot(self.build), raced_input)
        self.assertEqual((saved.read_bytes(), stat.S_IMODE(saved.stat().st_mode)), (original_bytes, original_mode))

    def test_copy_rejects_source_identity_change_after_open(self):
        stage = self.module()
        verified = stage.verify_runtime(self.build, FIXTURE_COMMIT)
        out = self.base / 'source-after-open-output'
        entry = self.runtime / 'bin/voice-runtime'
        saved = self.base / 'held-open-source'
        original_bytes, original_mode = entry.read_bytes(), stat.S_IMODE(entry.stat().st_mode)
        original_open = os.open
        swapped = False
        raced_input = None

        def race(file, flags, *args, **kwargs):
            nonlocal swapped, raced_input
            if file == 'voice-runtime' and flags & os.O_CREAT and not swapped:
                swapped = True
                entry.rename(saved)
                entry.write_bytes(original_bytes)
                entry.chmod(original_mode)
                raced_input = self.filesystem_snapshot(self.build)
            return original_open(file, flags, *args, **kwargs)

        error = None
        with mock.patch.object(stage.os, 'open', side_effect=race):
            try:
                stage.copy_runtime(verified, out)
            except (ValueError, OSError) as caught:
                error = caught
        self.assertTrue(swapped)
        self.assertRegex(str(error), 'UNSAFE_FILE_CHANGED', 'a matching final hash must not hide a changed source inode')
        self.assertEqual(self.filesystem_snapshot(self.build), raced_input)
        self.assertEqual((saved.read_bytes(), stat.S_IMODE(saved.stat().st_mode)), (original_bytes, original_mode))

    def test_private_metadata_mkdir_race_never_creates_outside_entries(self):
        """Swap a held parent immediately before real mkdir; no outside side effects."""
        stage = self.module()
        out = self.base / 'metadata-output'
        victim = out / 'resources'
        victim.mkdir(mode=0o700, parents=True)
        outside = self.base / 'outside-metadata'
        outside.mkdir(mode=0o750)
        sentinel = outside / 'sentinel'
        sentinel.write_bytes(b'METADATA_SENTINEL_UNTOUCHED')
        sentinel.chmod(0o640)
        before = self.filesystem_snapshot(outside)
        original_mkdir, original_path_mkdir = os.mkdir, Path.mkdir
        swapped = False

        def swap(path):
            nonlocal swapped
            if Path(path).name == 'manifests' and not swapped:
                swapped = True
                victim.rename(out / 'saved-resources')
                victim.symlink_to(outside, target_is_directory=True)

        def race(path, mode=0o777, **kwargs):
            swap(path)
            return original_mkdir(path, mode, **kwargs)

        def path_race(path, *args, **kwargs):
            # Python 3.9 pathlib caches os.mkdir; schedule both public seams.
            swap(path)
            return original_path_mkdir(path, *args, **kwargs)

        error = None
        with mock.patch.object(stage.os, 'mkdir', side_effect=race), \
                mock.patch.object(Path, 'mkdir', autospec=True, side_effect=path_race):
            try:
                stage.write_private(victim / 'manifests/catalog.json', b'NON_NATIVE_METADATA')
            except (ValueError, OSError) as caught:
                error = caught
        self.assertTrue(swapped, 'mkdir race was not delivered: ' + repr(error))
        self.assertFalse((outside / 'manifests').exists(), 'no external directory may be created')
        self.assertFalse((outside / 'manifests/catalog.json').exists(), 'no external file may be created')
        self.assertEqual(self.filesystem_snapshot(outside), before)
        self.assertIsNotNone(error)

    def test_stage_resource_mkdir_race_never_creates_outside_entries(self):
        """Real stage filesystem; only admission/sign and race scheduling doubled."""
        stage = self.module()
        out = self.base / 'raced-stage-root'
        outside = self.base / 'outside-stage-root'
        outside.mkdir(mode=0o750)
        sentinel = outside / 'sentinel'
        sentinel.write_bytes(b'STAGE_SENTINEL_UNTOUCHED')
        sentinel.chmod(0o640)
        before = self.filesystem_snapshot(outside)
        input_before = self.filesystem_snapshot(self.build)
        source = {'commit': FIXTURE_COMMIT, 'gitTree': '2' * 40, 'treeSha256': '3' * 64, 'files': []}
        original_mkdir, original_path_mkdir = os.mkdir, Path.mkdir
        swapped = False

        def swap(path):
            nonlocal swapped
            if Path(path).name == 'resources' and not swapped:
                swapped = True
                out.rename(self.base / 'saved-stage-root')
                out.symlink_to(outside, target_is_directory=True)

        def race(path, mode=0o777, **kwargs):
            swap(path)
            return original_mkdir(path, mode, **kwargs)

        def path_race(path, *args, **kwargs):
            swap(path)
            return original_path_mkdir(path, *args, **kwargs)

        error = None
        with mock.patch.object(stage, 'source_snapshot', return_value=source), \
                mock.patch.object(stage, 'verify_acquisition', return_value={}), \
                mock.patch.object(stage, 'sign_runtime', side_effect=ValueError('NON_NATIVE_SIGN_BOUNDARY')) as signing, \
                mock.patch.object(stage.os, 'mkdir', side_effect=race), \
                mock.patch.object(Path, 'mkdir', autospec=True, side_effect=path_race):
            try:
                stage.stage(self.build, self.base / 'acquisition', out)
            except (ValueError, OSError) as caught:
                error = caught
        self.assertTrue(swapped)
        self.assertFalse((outside / 'resources').exists(), 'no directory may escape through a replaced stage root')
        self.assertFalse((outside / 'failure.json').exists(), 'failure reporting must not follow the replaced root')
        self.assertEqual(self.filesystem_snapshot(outside), before)
        self.assertEqual(self.filesystem_snapshot(self.build), input_before)
        self.assertIsNotNone(error)
        signing.assert_not_called()

    def test_path_validation_keeps_symlink_evidence_before_identity_checks(self):
        stage = self.module()
        for raw in ['', 'relative', str(self.base) + '/x/../y', str(self.base) + '/./child',
                    str(self.base) + '//child', str(self.base) + '/child/', '/' + str(self.base),
                    str(self.base) + '\0']:
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, 'UNSAFE_PATH'):
                stage.checked_path(raw)
        before = self.filesystem_snapshot(self.build)
        for dangling in [False, True]:
            alias = self.base / ('dangling-alias' if dangling else 'build-alias')
            alias.symlink_to(self.base / 'missing' if dangling else self.build, target_is_directory=True)
            for position in ['runtime', 'acquisition', 'output']:
                with self.subTest(dangling=dangling, position=position):
                    args = [self.build, self.base / 'acquisition', self.base / 'fresh-output']
                    args[['runtime', 'acquisition', 'output'].index(position)] = alias / 'child'
                    with mock.patch.object(stage, 'source_snapshot') as boundary:
                        with self.assertRaisesRegex(ValueError, 'UNSAFE_LINK'):
                            stage.stage(*args)
                    boundary.assert_not_called()
                    self.assertEqual(self.filesystem_snapshot(self.build), before)
                    self.assertFalse((self.base / 'fresh-output').exists())

    def test_directory_open_race_checks_type_identity_and_closes_fds(self):
        stage = self.module()
        for replacement in ['symlink', 'directory']:
            with self.subTest(replacement=replacement):
                out = self.base / ('directory-open-' + replacement)
                victim = out / 'resources'
                victim.mkdir(mode=0o700, parents=True)
                outside = self.base / ('outside-directory-open-' + replacement)
                outside.mkdir(mode=0o750)
                sentinel = outside / 'sentinel'
                sentinel.write_bytes(b'DIRECTORY_OPEN_SENTINEL')
                sentinel.chmod(0o640)
                before = self.filesystem_snapshot(outside)
                original_open = os.open
                swapped, opened_fds = False, []

                def race(file, flags, *args, **kwargs):
                    nonlocal swapped
                    if file == 'resources' and flags & os.O_DIRECTORY and not swapped:
                        swapped = True
                        victim.rename(out / 'saved-resources')
                        if replacement == 'symlink':
                            victim.symlink_to(outside, target_is_directory=True)
                        else:
                            victim.mkdir(mode=0o700)
                    fd = original_open(file, flags, *args, **kwargs)
                    opened_fds.append(fd)
                    return fd

                with mock.patch.object(stage.os, 'open', side_effect=race):
                    with self.assertRaises((ValueError, OSError)):
                        stage.write_private(victim / 'new.json', b'NON_NATIVE_METADATA')
                self.assertTrue(swapped)
                self.assertFalse((victim / 'new.json').exists())
                self.assertFalse((outside / 'new.json').exists())
                self.assertEqual(self.filesystem_snapshot(outside), before)
                for fd in set(opened_fds):
                    with self.assertRaises(OSError):
                        os.fstat(fd)

    def test_private_writes_never_overwrite_existing_files_links_or_specials(self):
        stage = self.module()
        outside = self.base / 'outside-existing-leaf'
        outside.mkdir()
        sentinel = outside / 'sentinel'
        sentinel.write_bytes(b'EXISTING_LEAF_SENTINEL')
        sentinel.chmod(0o640)
        for kind in ['file', 'symlink', 'hardlink', 'fifo', 'directory']:
            with self.subTest(kind=kind):
                out = self.base / ('existing-leaf-' + kind)
                out.mkdir(mode=0o700)
                target = out / 'metadata.json'
                if kind == 'file':
                    target.write_bytes(b'EXISTING_METADATA')
                    target.chmod(0o640)
                elif kind == 'symlink':
                    target.symlink_to(sentinel)
                elif kind == 'hardlink':
                    os.link(sentinel, target)
                elif kind == 'fifo':
                    os.mkfifo(target, 0o600)
                else:
                    target.mkdir(mode=0o700)
                before = {p: self.filesystem_snapshot(p) for p in [out, outside]}
                with self.assertRaises((ValueError, OSError)):
                    stage.write_private(target, b'NEVER_OVERWRITE')
                self.assertEqual({p: self.filesystem_snapshot(p) for p in before}, before)

    def test_copy_descriptor_lifetime_on_success_and_io_failures(self):
        stage = self.module()
        verified = stage.verify_runtime(self.build, FIXTURE_COMMIT)
        before = self.filesystem_snapshot(self.build)
        for failure in [None, 'fchmod', 'fdopen']:
            with self.subTest(failure=failure):
                out = self.base / ('fd-lifetime-' + str(failure))
                original_open, original_fchmod, original_fdopen = os.open, os.fchmod, os.fdopen
                opened_fds = []

                def trace(file, flags, *args, **kwargs):
                    fd = original_open(file, flags, *args, **kwargs)
                    opened_fds.append(fd)
                    return fd

                def fchmod(fd, mode):
                    if failure == 'fchmod':
                        raise OSError('NON_NATIVE_INJECTED_FCHMOD_FAILURE')
                    return original_fchmod(fd, mode)

                def fdopen(fd, mode, *args, **kwargs):
                    if failure == 'fdopen' and mode == 'wb':
                        raise OSError('NON_NATIVE_INJECTED_FDOPEN_FAILURE')
                    return original_fdopen(fd, mode, *args, **kwargs)

                with mock.patch.object(stage.os, 'open', side_effect=trace), \
                        mock.patch.object(stage.os, 'fchmod', side_effect=fchmod), \
                        mock.patch.object(stage.os, 'fdopen', side_effect=fdopen):
                    if failure:
                        with self.assertRaisesRegex(OSError, 'NON_NATIVE_INJECTED_'):
                            stage.copy_runtime(verified, out)
                    else:
                        stage.copy_runtime(verified, out)
                self.assertTrue(opened_fds)
                for fd in set(opened_fds):
                    with self.assertRaises(OSError, msg='descriptors must close on every path'):
                        os.fstat(fd)
                self.assertEqual(self.filesystem_snapshot(self.build), before)
                if failure is None:
                    self.assertEqual(stage.inventory(out / 'runtime'), verified['files'])
                    for directory in [out, *[p for p in out.rglob('*') if p.is_dir()]]:
                        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)

    def test_fresh_private_copy_preserves_g2p_and_never_links_or_overwrites(self):
        stage = self.module()
        self.assertTrue(hasattr(stage, 'copy_runtime'), 'private runtime copier is required')
        entry = self.runtime / 'bin/voice-runtime'
        entry.chmod(0o755)
        before = {p: (self.runtime / p).read_bytes() for p in self.payloads}
        verified = stage.verify_runtime(self.build, FIXTURE_COMMIT)
        assets = self.base / 'assets'
        stage.copy_runtime(verified, assets)
        self.assertEqual(assets.stat().st_mode & 0o777, 0o700)
        for rel, expected in before.items():
            copied = assets / 'runtime' / rel
            self.assertEqual(copied.read_bytes(), expected)
            self.assertNotEqual(copied.stat().st_ino, (self.runtime / rel).stat().st_ino)
            self.assertEqual(copied.stat().st_nlink, 1)
            self.assertEqual(copied.stat().st_mode & 0o777, 0o700 if rel == 'bin/voice-runtime' else 0o600)
        with self.assertRaisesRegex(ValueError, 'OUTPUT_EXISTS'):
            stage.copy_runtime(verified, assets)
        self.assertEqual({p: (self.runtime / p).read_bytes() for p in self.payloads}, before)

    def test_runtime_copy_refuses_embedded_stt_tts_weights_even_when_receipted(self):
        stage = self.module()
        self.assertTrue(hasattr(stage, 'copy_runtime'), 'runtime model separation is required')
        for name in ['kokoro-v1.0.fp16.onnx', 'weights.safetensors', 'voices-v1.0.bin']:
            with self.subTest(name=name):
                payload = self.runtime / 'bin/_internal' / name
                payload.write_bytes(b'NON_NATIVE_MODEL_FIXTURE')
                self.receipt['treeSha256'] = self.tree_sha()
                self.receipt['fileCount'] = len(self.payloads) + 1
                self.write_receipt()
                verified = stage.verify_runtime(self.build, FIXTURE_COMMIT)
                with self.assertRaisesRegex(ValueError, 'EMBEDDED_SPEECH_MODEL'):
                    stage.copy_runtime(verified, self.base / name)
                self.assertFalse((self.base / name).exists())
                payload.unlink()

    def test_runtime_filesystem_envelope_refuses_links_specials_and_unlisted_directories(self):
        stage = self.module()
        target = self.runtime / 'bin/voice-runtime'
        bad = self.runtime / 'bin/forbidden'
        for kind in ['symlink', 'hardlink', 'fifo', 'empty', 'unsafe name', 'con.txt']:
            with self.subTest(kind=kind):
                p = bad if kind not in ['unsafe name', 'con.txt'] else self.runtime / kind
                if kind == 'symlink':
                    p.symlink_to(target)
                elif kind == 'hardlink':
                    os.link(target, p)
                elif kind == 'fifo':
                    os.mkfifo(p)
                elif kind == 'empty':
                    p.mkdir()
                else:
                    p.write_bytes(b'bad')
                try:
                    with self.assertRaisesRegex(ValueError, 'UNSAFE_|UNLISTED_DIRECTORY'):
                        stage.verify_runtime(self.build, FIXTURE_COMMIT)
                finally:
                    p.rmdir() if kind == 'empty' else p.unlink()
        alias = self.base / 'build-alias'
        alias.symlink_to(self.build, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_LINK'):
            stage.verify_runtime(alias, FIXTURE_COMMIT)

    def test_receipt_requires_same_committed_source_and_valid_claims(self):
        stage = self.module()
        for change, expected in [
            ({'commit': '2' * 40}, 'SOURCE_COMMIT_MISMATCH'),
            ({'commit': FIXTURE_COMMIT.upper() + 'x'}, 'RECEIPT_INVALID'),
            ({'class': 'NON_NATIVE_TEST_FIXTURE'}, 'RECEIPT_INVALID'),
            ({'symlinks': ['bin/alias']}, 'RECEIPT_INVALID'),
            ({'nonPortableNames': ['unsafe name']}, 'RECEIPT_INVALID'),
            ({'fileCount': True}, 'RECEIPT_INVALID'),
            ({'treeSha256': self.receipt['treeSha256'].upper()}, 'RECEIPT_INVALID'),
        ]:
            with self.subTest(change=change):
                original = self.receipt.copy()
                self.receipt.update(change)
                self.write_receipt()
                with self.assertRaisesRegex(ValueError, expected):
                    stage.verify_runtime(self.build, FIXTURE_COMMIT)
                self.receipt = original
        self.write_receipt()

    def test_receipt_verification_hashes_actual_runtime_bytes(self):
        stage = self.module()
        verified = stage.verify_runtime(self.build, FIXTURE_COMMIT)
        self.assertEqual(verified['receipt'], self.receipt)
        self.assertEqual(verified['root'], self.runtime)
        self.assertEqual(verified['receiptSha256'], hashlib.sha256((self.build / 'receipt.json').read_bytes()).hexdigest())
        self.assertEqual({f['path'] for f in verified['files']}, set(self.payloads))
        (self.runtime / 'bin/voice-runtime').write_bytes(b'tampered fixture')
        with self.assertRaisesRegex(ValueError, 'RUNTIME_RECEIPT_MISMATCH'):
            stage.verify_runtime(self.build, FIXTURE_COMMIT)


if __name__ == '__main__':
    unittest.main()
