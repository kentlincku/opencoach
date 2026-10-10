"""Opt-in PRIVATE real SDK replay. No SDK text is stored in this module.

SDK_CORPUS_ANALYSIS must name the verified analysis directory. Linux filesystem
and root/UID seams are NOT Darwin/native/ABI validation. Missing env skips only
ordinary repository runs; evidence runs require it and assert zero skips.
"""
import hashlib
import json
import os
from pathlib import Path
import unittest
import test_native_prerequisite as core

c = core.c

def corpus():
    root = Path(os.environ['SDK_CORPUS_ANALYSIS'])
    map_raw = (root/'present-files.json').read_bytes()
    if hashlib.sha256(map_raw).hexdigest() != '935468c5441b2f70a9e66ad011766be4cad0c9ad5eb9c1327bb1b800b29ec3a4':
        raise AssertionError('unverified private corpus map')
    mapping = json.loads(map_raw)
    if len(mapping) != 30: raise AssertionError('expected verified 30-file corpus')
    values = {}
    for relative, item in mapping.items():
        raw = (root/'present-staging'/item['entry']).read_bytes()
        if len(raw) != item['bytes'] or hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise AssertionError('private corpus mismatch: '+relative)
        values[relative] = raw
    return values

@unittest.skipUnless(os.environ.get('SDK_CORPUS_ANALYSIS'), 'private corpus opt-in')
class RealSDKTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = corpus()
        cls.texts = {p:r.decode('utf-8') for p,r in cls.raw.items() if p.endswith('.h')}

    def test_full_required_flow_on_real_distributed_headers(self):
        import test_macos_sdk_headers as headers
        case = headers.HeaderTests(); case.setUp()
        adapter, sdk, _ = case.fixture()
        try:
            for path, raw in self.raw.items():
                target = sdk/path
                if target.is_symlink(): target = target.resolve()
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
                self.assertEqual(target.read_bytes(), raw)
            budget = c.io.Budget()  # OFFLINE standalone accounting, NOT normal parent flow.
            out = adapter.new_output(adapter.bind_root(str(case.root), 'private-parent'), 'real-analysis')
            result = c.collect('mac-sdk', adapter=adapter, out=out, budget=budget, sdk='clt')
            obs = json.loads((out.path/'observations.json').read_bytes())
            if os.environ.get('S'):
                (Path(os.environ['S'])/'latest-offline-flow.json').write_text(json.dumps(dict(
                    out=str(out.path), counts=budget.counts(), result=result,
                    unresolved=obs['mac'][0].get('unresolved')), indent=2))
            self.assertEqual((result['status'], result['reason']), ('CAPTURED_PREREQUISITE_ONLY', None))
            c.validate_observations(obs, 'mac-sdk')
            declarations = obs['mac'][0]['declarations']
            self.assertEqual(set(declarations), set(c.REQUIRED) | {
                'MAXCOMLEN', 'int32_t', '__darwin_uid_t', '__darwin_gid_t', '__darwin_pid_t',
                '__uint32_t', '__uint64_t', '__int32_t'})
            for symbol in ('__uint32_t', '__uint64_t', '__int32_t'):
                self.assertEqual({r['relative'] for r in declarations[symbol]},
                                 {'usr/include/arm/_types.h', 'usr/include/i386/_types.h'})
            self.assertEqual(budget.files, len(obs['inputs']))
            self.assertEqual(len({r['relative'] for r in obs['inputs']}), budget.files)
            self.assertNotIn('usr/include/AvailabilityInternalLegacy.h', {r['relative'] for r in obs['inputs']})
            for symbol, records in declarations.items():
                for r in records:
                    raw = self.raw[r['relative']]; start = r['start_offset']; body = r['text'].encode()
                    self.assertEqual(raw[start:start+len(body)], body)
                    self.assertEqual(raw[:start].count(b'\n')+1, r['start_line'])
                    self.assertEqual(r['end_line']-r['start_line']+1, len(r['text'].splitlines()))
                    self.assertIs(r['conditions_evaluated'], False)
            print('REAL_OFFLINE_FLOW_NOT_DARWIN', out.path, budget.counts(), flush=True)
        finally:
            adapter.close()

    def test_all_thirty_files_required_dependency_ledger(self):
        pending = list(c.REQUIRED); ledger = {}; total = 0
        while pending:
            symbol = pending.pop(0)
            if symbol in ledger: continue
            self.assertLess(len(ledger), 128)
            records = []; dependencies = set()
            for path, text in self.texts.items():
                for kind, decl, record in c._definition(text, symbol):
                    deps = c._dependencies(kind, decl, symbol)
                    dependencies.update(deps)
                    start = c._clean(text).index(decl)
                    raw_decl = text[start:start+len(decl)].encode()
                    records.append(dict(relative=path, kind=kind,
                        source_sha256=hashlib.sha256(self.raw[path]).hexdigest(),
                        declaration_offset=len(text[:start].encode()), declaration_bytes=len(raw_decl),
                        declaration_sha256=hashlib.sha256(raw_decl).hexdigest(),
                        context_offset=record['start_offset'], context_bytes=len(record['text'].encode()),
                        start_line=record['start_line'], end_line=record['end_line'],
                        conditions_evaluated=record['conditions_evaluated'], dependencies=sorted(deps)))
                    total += len(record['text'].encode())
            self.assertTrue(records, symbol)
            ledger[symbol] = records
            pending.extend(sorted(dependencies-set(ledger)))
        self.assertEqual(len(ledger), 20)
        self.assertLess(total, c.io.SHARE_CAP)
        self.assertTrue(all(r['context_bytes'] <= 65536 for rs in ledger.values() for r in rs))
        if os.environ.get('S'):
            (Path(os.environ['S'])/'required-dependency-ledger.json').write_text(json.dumps(dict(
                scope='PRIVATE_PARTIAL_CORPUS_STATIC_NOT_NATIVE', scanned_files=len(self.raw),
                scanned_sdk_bytes=sum(map(len, self.raw.values())), symbols=ledger,
                unresolved_required=[], total_excerpt_bytes=total,
                annotations='Known finite suffix syntax retained in original contexts, NOT expanded or type/value edges',
                native='NOT_RUN', active_branch='NOT_CAPTURED', abi='NOT_CAPTURED'), indent=2))

    def test_real_annotation_macro_grammar_remains_outside_type_graph(self):
        # Genuine function-like annotation macros include bound parameters and
        # token-pasting. This is NOT a claim that the finite parser expands C.
        text = self.texts['usr/include/Availability.h']
        for symbol in ('__OS_AVAILABILITY', '__OSX_AVAILABLE_STARTING'):
            definitions = c._definition(text, symbol)
            self.assertTrue(definitions)
            for kind, decl, record in definitions:
                self.assertEqual(kind, 'macro')
                with self.assertRaisesRegex(c.io.Stop, '^NOT_CAPTURED$'):
                    c._dependencies(kind, decl, symbol)
                self.assertIs(record['conditions_evaluated'], False)
        # Large enclosing header spans are still refused, not silently truncated
        # or given a raised cap. This optional compiler macro is not reachable
        # from the required type/value graph.
        with self.assertRaisesRegex(c.io.Stop, '^CAP_EXCEEDED$'):
            c._definition(self.texts['usr/include/AvailabilityInternal.h'],
                          '__swift_compiler_version_at_least_impl')

    def test_unknown_bare_suffix_remains_a_dependency(self):
        self.assertEqual(c._dependencies('function', 'pid_t vfork(void) OTHER_ANNOTATION;', 'vfork'),
                         {'pid_t', 'OTHER_ANNOTATION'})
        self.assertEqual(c._dependencies('macro', '#define SIZE (2 * REAL_VALUE)', 'SIZE'), {'REAL_VALUE'})

    def test_annotation_syntax_is_not_type_or_value_dependency(self):
        for symbol, path, expected in (
            ('vfork', 'usr/include/unistd.h', {'pid_t'}),
            ('proc_pidinfo', 'usr/include/libproc.h', {'uint64_t'}),
        ):
            definitions = c._definition(self.texts[path], symbol)
            self.assertEqual(len(definitions), 1)
            kind, decl, record = definitions[0]
            self.assertEqual(c._dependencies(kind, decl, symbol), expected)
            # Original annotation spelling and unevaluated context remain evidence.
            self.assertIn('__', record['text'])
            self.assertIs(record['conditions_evaluated'], False)
        for suffix in ('UNKNOWN(uid_t)', '__OSX_AVAILABLE_STARTING(uid_t, __IPHONE_2_0)',
                       '__WATCHOS_PROHIBITED(uid_t)', '__OSX_AVAILABLE_STARTING(__MAC_10_5)'):
            with self.subTest(suffix=suffix), self.assertRaisesRegex(c.io.Stop, '^NOT_CAPTURED$'):
                c._dependencies('function', 'int proc_pidinfo(void) '+suffix+';', 'proc_pidinfo')
