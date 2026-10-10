"""Portable first-party spec/hook execution with strict PyInstaller/import doubles.

Only the two fixed repository files below are exec'd. No installed PyInstaller,
inflect, typeguard, external source or TOC is imported/executed. These contracts
are not a frozen build or native acceptance. Run under the resource guard.
"""
import argparse
import builtins
import importlib.util
import os
from pathlib import Path
from types import ModuleType, SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

# Host-separator TOC destination produced by the fake Analysis below.
INFLECT_DEST = str(Path('inflect') / '__init__.py')

ROOT = Path(__file__).resolve().parents[1]
SPIKE = ROOT / 'spikes/packaged-runtime'


def execute_firstparty(filename, imports, namespace):
    assert filename in ('voice-runtime.spec', 'pyi_rth_native_alias.py')
    def restricted_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level or name not in imports:
            raise AssertionError('Unexpected spec/hook import: ' + name)
        return imports[name]
    namespace['__builtins__'] = dict(vars(builtins), __import__=restricted_import)
    path = SPIKE / filename
    exec(compile(path.read_bytes(), str(path), 'exec'), namespace)


class FrozenSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('DIAGNOSTIC_TEST_TMP'))
        self.addCleanup(self.tmp.cleanup)
        # Resolve the temp root: on macOS TMPDIR lives under /var -> /private/var,
        # and windows_bundle.physical() rightly refuses any symlinked ancestor.
        self.root = Path(self.tmp.name).resolve()
        spec = importlib.util.spec_from_file_location('frozen_source_bundle', SPIKE / 'windows_bundle.py')
        self.bundle = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.bundle)  # first-party stdlib-only admission/validation

    def run_spec(self, *, refusal=None, tamper=None):
        original = self.root / 'admitted.json'; original.write_bytes(b'{}')
        source = self.root / '__init__.py'; source.write_text('def source_visible(): return 42\n', encoding='utf-8')
        plan = dict(source=str(self.root), hiddenimports=['inflect'], excludes=['torch'],
                    datas=[(str(original), 'vendor')], wheels={})
        events = []
        def collect_data_files(package, include_py_files=False):
            self.assertEqual((package, include_py_files), ('inflect', True))
            self.assertEqual(events, ['native', 'prepared', 'installed'])
            events.append('source')
            return [(str(source), 'inflect')]
        def native():
            events.append('native')
            if refusal == 'native':
                with patch('platform.system', return_value='Linux'):
                    self.bundle.require_native_original()
        def prepared(*args):
            events.append('prepared')
            self.assertEqual(args, (self.root/'missing', '0'*64, self.root/'wheels', self.root/'prepared'))
            if refusal == 'prepared': return self.bundle.verify_prepared_original(*args)
            return plan
        def installed(p):
            events.append('installed'); self.assertIs(p, plan)
            return self.bundle.verify_installed_original(p, distributions=[], roots=[])
        def analysis(scripts, **kwargs):
            events.append('Analysis')
            self.assertEqual(scripts, [str(ROOT/'native/python/voice_runtime/server.py')])
            self.assertEqual(kwargs['hiddenimports'], plan['hiddenimports'])
            self.assertEqual(kwargs['excludes'], ['torch'])
            self.assertTrue(kwargs['noarchive'])
            self.assertEqual(kwargs['runtime_hooks'], [str(SPIKE/'pyi_rth_native_alias.py')])
            rows = [(str(Path(dest)/Path(src).name), src, 'DATA') for src, dest in kwargs['datas']]
            # Fake TOC uses host separators like PyInstaller does (backslash on Windows).
            if tamper == 'missing': rows = [r for r in rows if r[0] != INFLECT_DEST]
            if tamper == 'duplicate': rows.append(rows[0])
            if tamper == 'unsafe': rows.append(('../escape.py', str(source), 'DATA'))
            return SimpleNamespace(pure=[], scripts=[], binaries=[], datas=rows)
        def validate(a, p):
            events.append('validate'); self.assertIs(p, plan)
            return self.bundle.validate_collection_original(a, p)
        def pyz(pure): events.append('PYZ'); return object()
        def exe(*args, **kwargs): events.append('EXE'); return object()
        def collect(*args, **kwargs): events.append('COLLECT'); return object()
        imports = {'pathlib': __import__('pathlib'), 'platform': SimpleNamespace(system=lambda: 'Windows'),
                   'sys': SimpleNamespace(path=[]), 'argparse': argparse, 'windows_bundle': self.bundle,
                   'PyInstaller.utils.hooks': SimpleNamespace(collect_data_files=collect_data_files)}
        namespace = dict(SPECPATH=str(SPIKE), Analysis=analysis, PYZ=pyz, EXE=exe, COLLECT=collect)
        for name in ('require_native', 'verify_prepared', 'verify_installed', 'validate_collection'):
            setattr(self.bundle, name + '_original', getattr(self.bundle, name))
        argv = ['spec', '--bundle', str(self.root/'missing'), '--bundle-sha256', '0'*64,
                '--wheelhouse', str(self.root/'wheels'), '--prepared', str(self.root/'prepared')]
        with patch.object(sys, 'argv', argv), patch.multiple(self.bundle, require_native=native,
                verify_prepared=prepared, verify_installed=installed, validate_collection=validate):
            try:
                execute_firstparty('voice-runtime.spec', imports, namespace)
            finally:
                self.events = events
        return namespace, plan

    def test_source_files_flow_into_analysis_and_existing_validation(self):
        ns, plan = self.run_spec()
        self.assertEqual(self.events, ['native', 'prepared', 'installed', 'source', 'Analysis',
                                       'validate', 'PYZ', 'EXE', 'COLLECT'])
        self.assertIn((str(self.root/'__init__.py'), 'inflect'), plan['datas'])
        self.assertIn((INFLECT_DEST, str(self.root/'__init__.py'), 'DATA'), ns['a'].datas)

    def test_missing_inflect_source_is_rejected_before_pyz(self):
        with self.assertRaisesRegex(ValueError, 'collected resource missing'):
            self.run_spec(tamper='missing')
        self.assertNotIn('PYZ', self.events)

    def test_existing_collection_refusals_still_run(self):
        for tamper in ('duplicate', 'unsafe'):
            with self.subTest(tamper=tamper), self.assertRaises(ValueError):
                self.run_spec(tamper=tamper)
            self.assertNotIn('PYZ', self.events)

    def test_real_native_and_prepared_admission_refuse_before_analysis(self):
        for gate in ('native', 'prepared'):
            with self.subTest(gate=gate), self.assertRaises((ValueError, FileNotFoundError)):
                self.run_spec(refusal=gate)
            self.assertNotIn('Analysis', self.events)
            self.assertNotIn('source', self.events)

    def test_hook_preserves_typeguard_identity_and_native_aliases(self):
        import types
        voice = ModuleType('voice_runtime')
        voice.backend_registry = ModuleType('voice_runtime.backend_registry')
        voice.backends = ModuleType('voice_runtime.backends')
        voice.backends.base = ModuleType('voice_runtime.backends.base')
        public, internal = object(), object()
        guard = SimpleNamespace(typechecked=public, _decorators=SimpleNamespace(typechecked=internal))
        modules = {'typeguard': guard, 'typeguard._decorators': guard._decorators}
        imports = {name: voice for name in ('voice_runtime', 'voice_runtime.backend_registry',
                    'voice_runtime.backends', 'voice_runtime.backends.base')}
        imports.update(sys=SimpleNamespace(modules=modules), types=types, typeguard=guard)
        execute_firstparty('pyi_rth_native_alias.py', imports, {})
        self.assertIs(guard.typechecked, public)
        self.assertIs(guard._decorators.typechecked, internal)
        self.assertIs(modules['native.python.voice_runtime'], voice)
        self.assertIs(modules['native.python.voice_runtime.backend_registry'], voice.backend_registry)
        self.assertIs(modules['native.python.voice_runtime.backends'], voice.backends)
        self.assertIs(modules['native.python.voice_runtime.backends.base'], voice.backends.base)
        self.assertIs(modules['native'].python, modules['native.python'])
        self.assertIs(modules['native.python'].voice_runtime, voice)


if __name__ == '__main__':
    unittest.main(verbosity=2)
