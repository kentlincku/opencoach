"""Portable fixtures only: never invokes Darwin tools or compiles native code."""
import importlib.util
from pathlib import Path
import sys
import unittest

SPIKE = Path(__file__).resolve().parents[1] / 'spikes' / 'darwin-lifetime'
sys.path.insert(0, str(SPIKE))


class MetricsTests(unittest.TestCase):
    def test_free_pages_lower_bound_and_missing_rejected(self):
        self.assertTrue((SPIKE / 'darwin_guard.py').is_file(), 'guard implementation missing')
        import darwin_guard as g
        fixture = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 65536.\nPages inactive: 999999.\n'
        self.assertEqual(g.parse_free(fixture), 1073741824)
        for bad in ('', 'Pages free: 1.', fixture + 'Pages free: 1.\n', fixture.replace('65536.', '-1.')):
            with self.subTest(bad=bad), self.assertRaises(g.GuardError):
                g.parse_free(bad)


class CollectorTests(unittest.TestCase):
    def test_real_capture_and_resource_abort(self):
        import darwin_guard as g
        self.assertTrue(hasattr(g, 'collect'), 'bounded collector missing')
        import subprocess
        import time
        def sample(pid):
            return {'free': 2 * g.MIB * 1024, 'rss': 100, 'identity': (pid, 1), 'descendants': []}
        p = subprocess.Popen([sys.executable, '-B', '-c', 'import time; print("receipt", flush=True); time.sleep(.12)'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        result = g.collect(p, sample, time.monotonic() + 2)
        self.assertEqual(result['stdout'], b'receipt\n')
        self.assertEqual(result['status'], 'OK')
        self.assertTrue(result['reaped'])
        self.assertEqual(result['pid'], p.pid)
        for kind in ('reserve', 'rss', 'identity', 'missing', 'deadline', 'cap', 'stderr-cap', 'gap', 'cancel'):
            with self.subTest(kind=kind):
                script = 'import time; time.sleep(.3)'
                if kind == 'cap':
                    script = 'import sys,time; sys.stdout.write("x"*300000); sys.stdout.flush(); time.sleep(.3)'
                if kind == 'stderr-cap':
                    script = 'import sys,time; sys.stderr.write("x"*300000); sys.stderr.flush(); time.sleep(.3)'
                p = subprocess.Popen([sys.executable, '-B', '-c', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                n = [0]
                def broken(pid):
                    s = sample(pid)
                    n[0] += 1
                    if kind == 'reserve': s['free'] = 0
                    if kind == 'rss': s['rss'] = 385 * g.MIB
                    if kind == 'identity': s['identity'] = (pid, n[0])
                    if kind == 'missing': raise g.GuardError('MISSING')
                    if kind == 'gap': time.sleep(.17)
                    return s
                r = g.collect(p, broken, time.monotonic() + (-1 if kind == 'deadline' else 2), cancelled=lambda: kind == 'cancel')
                self.assertNotEqual(r['status'], 'OK')
                self.assertTrue(r['reaped'])
                self.assertLessEqual(len(r['stdout']), g.CAP)


class AdmissionTests(unittest.TestCase):
    def test_numeric_tree_is_not_parent_only(self):
        import darwin_guard as g
        table = g.parse_ps('10 1 501 100\n11 10 501 200\n12 11 501 300\n99 1 501 900\n')
        self.assertEqual(g.tree_members(table, 10), {10, 11, 12})
        self.assertEqual(sum(table[p]['rss'] for p in g.tree_members(table, 10)), 614400)
        for text in ('', '1 2 3', '1 2 3 -1', '1 2 3 4\n1 2 3 5'):
            with self.assertRaises(g.GuardError): g.parse_ps(text)
        with self.assertRaises(g.GuardError): g.tree_members(table, 88)

    def test_existing_unknown_output_refused(self):
        import run_probe as r
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory).resolve()
            output = r.owned_output(str(parent / 'fresh'))
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(FileExistsError): r.owned_output(str(output))
            (parent / 'link').symlink_to(output, target_is_directory=True)
            with self.assertRaises((FileExistsError, r.ProbeError)): r.owned_output(str(parent / 'link'))

    def test_wrong_host_preflight_does_not_launch_tools(self):
        import run_probe as r
        from unittest.mock import patch
        with patch.object(r.platform, 'system', return_value='Linux'), patch.object(r, 'small_tool') as tool:
            with self.assertRaises(r.ProbeError): r.preflight({})
            tool.assert_not_called()

    def test_compiler_missing_preflight_stops_before_any_command(self):
        import run_probe as r
        from unittest.mock import patch, Mock
        fake = Mock()
        fake.identity.return_value.svuid = 501
        fake.identity.return_value.svgid = 20
        with patch.object(r.platform, 'system', return_value='Darwin'), patch.object(r.platform, 'machine', return_value='arm64'), patch.object(r.os, 'getuid', return_value=501), patch.object(r.os, 'geteuid', return_value=501), patch.object(r.os, 'getgid', return_value=20), patch.object(r.os, 'getegid', return_value=20), patch.object(r, 'DarwinSampler', return_value=fake), patch.object(r, 'ctypes_issetugid', return_value=0), patch.object(r.Path, 'is_file', return_value=False), patch.object(r, 'small_tool') as tool:
            with self.assertRaisesRegex(r.ProbeError, 'EXISTING_APPLE_COMPILER'): r.preflight({})
            tool.assert_not_called()

    def test_root_preflight_stops_before_metrics(self):
        import run_probe as r
        from unittest.mock import patch
        with patch.object(r.platform, 'system', return_value='Darwin'), patch.object(r.platform, 'machine', return_value='arm64'), patch.object(r.os, 'getuid', return_value=0), patch.object(r, 'DarwinSampler') as sampler:
            with self.assertRaises(r.ProbeError): r.preflight({})
            sampler.assert_not_called()

    def test_real_cli_linux_stop_and_no_native_measurement(self):
        import run_probe as r
        import tempfile
        import json
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory, patch.object(r.platform, 'system', return_value='Linux'), patch.object(r.subprocess, 'Popen') as spawn:
            out = Path(directory).resolve() / 'evidence'
            self.assertEqual(r.main(['--out', str(out)]), 3)
            event = json.loads((out / 'result.json').read_text())
            self.assertEqual(event['status'], 'STOP')
            self.assertFalse(event['native_measured'])
            self.assertTrue(all(c['status'] == 'NOT_RUN' for c in event['cases']))
            spawn.assert_not_called()


class SamplerContractTests(unittest.TestCase):
    def test_seen_descendant_surviving_original_exit_is_stop_not_tree_pass(self):
        import darwin_guard as g
        from unittest.mock import patch
        self.assertTrue(hasattr(g.DarwinSampler, 'finish'), 'post-reap descendant check missing')
        sampler = object.__new__(g.DarwinSampler)
        sampler.env = {}
        sampler.known = {100: (100, 1, 1), 200: (200, 1, 2), 201: (201, 1, 3)}
        with patch.object(g.os, 'getpid', return_value=100), patch.object(g, 'small_tool', return_value=('100 1 501 1\n201 1 501 2\n900 100 501 1\n', 900)):
            with self.assertRaises(g.GuardError): sampler.finish(200)
        with patch.object(g.os, 'getpid', return_value=100), patch.object(g, 'small_tool', return_value=('100 1 501 1\n900 100 501 1\n', 900)):
            self.assertEqual(sampler.finish(200), 'NO_KNOWN_DESCENDANT_IN_SNAPSHOT_NOT_TREE_PROOF')

    def test_reaped_ps_helper_not_mistaken_for_live_descendant(self):
        import darwin_guard as g
        from unittest.mock import patch
        from types import SimpleNamespace
        sampler = object.__new__(g.DarwinSampler)
        sampler.env, sampler.known = {}, {}
        # Only the collector remains; ps (900) was already waited by small_tool.
        sampler.identity = lambda pid: SimpleNamespace(ppid=1, uid=501, ruid=501, svuid=501, start_sec=4, start_usec=1)
        def tool(argv, env, with_pid=False):
            if argv[0] == '/usr/bin/vm_stat':
                return 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 131072.\n'
            text = '100 1 501 1\n900 100 501 1\n'
            return (text, 900) if with_pid else text
        with patch.object(g.os, 'getpid', return_value=100), patch.object(g.os, 'getuid', return_value=501), patch.object(g, 'small_tool', side_effect=tool):
            snapshot = sampler(100)
            self.assertEqual(snapshot['descendants'], [])
            self.assertEqual(snapshot['rss'], 1024)


class ReceiptTests(unittest.TestCase):
    def test_forged_complete_matrix_is_not_accepted(self):
        import run_probe as r
        forged = [{'case': c, 'outcome': 'PASS'} for c in r.CASES]
        with self.assertRaises(r.ProbeError):
            r.validate_complete({'system': 'Darwin', 'machine': 'arm64', 'uid': 501}, forged)

    def test_real_collector_to_schema_and_false_pass_rejected(self):
        self.assertTrue((SPIKE / 'run_probe.py').is_file(), 'CLI/schema implementation missing')
        import darwin_guard as g
        import run_probe as r
        import json
        import subprocess
        import time
        event = {
            'schema': 1, 'case': 'fork', 'supervisor_pid': 100, 'child_pid': 101,
            'observed_pid': 101, 'ruid': 501, 'euid': 501, 'gid': 20, 'egid': 20,
            'saved_uid': 501, 'saved_gid': 20, 'issetugid': 0,
            'limited': True, 'soft': 0, 'hard': 0, 'limit_rc': 0,
            'before_soft': 2666, 'before_hard': 4000, 'parent_unchanged': True,
            'api_rc': -1, 'api_errno': 35, 'created_pid': 0, 'created_wait': -1,
            'wait_status': 0, 'reaped': True, 'outcome': 'PASS', 'exec_seen': False,
            'thread_seen': False, 'raise_rc': 0, 'raise_errno': 0, 'exec_errno': 0,
            'schedule_signal': 0,
        }
        # This is explicitly a synthetic Darwin receipt, not native evidence.
        script = 'import os,json,time; e=json.loads(' + repr(json.dumps(event)) + '); e["supervisor_pid"]=os.getpid(); print(json.dumps(e),flush=True); time.sleep(.1)'
        p = subprocess.Popen([sys.executable, '-B', '-c', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        result = g.collect(p, lambda pid: {'free': 2**31, 'rss': 1, 'identity': (pid, 1), 'descendants': []}, time.monotonic()+2)
        parsed = r.validate_case('fork', result)
        self.assertEqual(parsed['observed_pid'], 101)
        import copy
        for field, value in [('outcome', 'FAIL'), ('reaped', False), ('parent_unchanged', False), ('child_pid', 102), ('soft', 1), ('api_errno', 0), ('api_rc', 102), ('created_pid', 102), ('saved_uid', 0), ('wait_status', 9), ('exec_seen', True), ('schema', True)]:
            with self.subTest(field=field):
                bad = copy.deepcopy(result)
                e = json.loads(bad['stdout'])
                e[field] = value
                bad['stdout'] = json.dumps(e).encode()
                with self.assertRaises(r.ProbeError): r.validate_case('fork', bad)
        for raw in (b'', b'{}', result['stdout'] + result['stdout'], b'{broken', result['stdout'].replace(b'"schema": 1', b'"schema": 1, "schema": 1')):
            bad = dict(result, stdout=raw)
            with self.assertRaises(r.ProbeError): r.validate_case('fork', bad)
        for key, value in [('status', 'OUTPUT_CAP'), ('returncode', 1), ('returncode', False), ('reaped', False)]:
            with self.assertRaises(r.ProbeError): r.validate_case('fork', dict(result, **{key: value}))
        with self.assertRaises(r.ProbeError): r.validate_complete({'system': 'Linux', 'machine': 'arm64'}, [])
        with self.assertRaises(r.ProbeError): r.validate_complete({'system': 'Darwin', 'machine': 'arm64'}, [parsed])
        events, captures = [], []
        for case in r.CASES:
            e = dict(parsed, case=case, api_rc=0, api_errno=0)
            api = case.removeprefix('control-').removeprefix('exec-').removeprefix('thread-')
            if case.startswith('control-') or case == 'cancel-before':
                e.update(limited=False, limit_rc=-2, soft=e['before_soft'], hard=e['before_hard'])
            if case.startswith('control-'):
                e.update(created_pid=102, created_wait=0, api_rc=0 if api.startswith('posix') else 102)
            elif api in r.APIS:
                e.update(api_rc=35 if api.startswith('posix') else -1, api_errno=35)
            e.update(exec_seen=case.startswith('exec-'), thread_seen=case.startswith('thread-'))
            if case in ('raise', 'exec-raise'): e.update(raise_rc=-1, raise_errno=1)
            if case == 'execfailure': e['exec_errno'] = 2
            if case in ('term', 'cancel-before', 'cancel-after', 'timeout'):
                sig = 9 if case == 'timeout' else 15
                e.update(wait_status=sig, schedule_signal=sig)
            capture = dict(result, stdout=json.dumps(e).encode())
            events.append(r.validate_case(case, capture))
            captures.append(capture)
        host = {'system': 'Darwin', 'machine': 'arm64', 'uid': 501}
        self.assertEqual(r.validate_complete(host, events, captures), 'FINITE_MATRIX_MEASURED_PARTIAL')
        with self.assertRaises(r.ProbeError): r.validate_complete(host, events, captures[:-1])


class ExceptionOwnershipTests(unittest.TestCase):
    """Real Python originals; observations precede ALL harness poll/wait/cleanup."""
    @staticmethod
    def metric(pid):
        return {'free': 2**31, 'rss': 1, 'identity': (pid, 1), 'descendants': []}

    @staticmethod
    def fallback(p, label):
        import json
        # Do not poll here before recording: a harness reap cannot satisfy the test.
        used = p.returncode is None or not p.stdout.closed or not p.stderr.closed
        print(json.dumps({'fixture': label, 'pid': p.pid,
                          'candidate_returncode': p.returncode,
                          'candidate_pipes_closed': p.stdout.closed and p.stderr.closed,
                          'harness_cleanup_needed': used}), flush=True)
        if p.poll() is None: p.terminate()
        p.wait(timeout=2)
        for pipe in (p.stdout, p.stderr):
            if not pipe.closed: pipe.close()

    def test_collector_exception_boundaries_keep_original_receipt(self):
        import darwin_guard as g
        import subprocess, time
        from contextlib import ExitStack
        from unittest.mock import patch
        real_selector = g.selectors.DefaultSelector
        for fault in ('metrics-timeout', 'pipe-read', 'constructor', 'register',
                      'nonblocking', 'selector-close', 'pipe-close'):
            with self.subTest(fault=fault):
                p = subprocess.Popen([sys.executable, '-B', '-c',
                                      'import time; print("ready",flush=True); time.sleep(2)'],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                result, escaped = None, None
                try:
                    with ExitStack() as stack:
                        def metric(pid):
                            if fault == 'metrics-timeout':
                                raise subprocess.TimeoutExpired('fixture-metric', 1)
                            return self.metric(pid)
                        if fault == 'constructor':
                            stack.enter_context(patch.object(g.selectors, 'DefaultSelector', side_effect=OSError('setup')))
                        elif fault in ('register', 'selector-close'):
                            sel = real_selector()
                            if fault == 'register':
                                stack.enter_context(patch.object(sel, 'register', side_effect=OSError('register')))
                            else:
                                close = sel.close
                                def fail_close():
                                    close()
                                    raise OSError('selector-close')
                                stack.enter_context(patch.object(sel, 'close', side_effect=fail_close))
                            stack.enter_context(patch.object(g.selectors, 'DefaultSelector', return_value=sel))
                        elif fault == 'nonblocking':
                            stack.enter_context(patch.object(g.os, 'set_blocking', side_effect=OSError('nonblocking')))
                        elif fault == 'pipe-read':
                            stack.enter_context(patch.object(g.os, 'read', side_effect=OSError('read')))
                        elif fault == 'pipe-close':
                            close = p.stdout.close
                            def fail_pipe_close():
                                close()
                                raise OSError('pipe-close')
                            stack.enter_context(patch.object(p.stdout, 'close', side_effect=fail_pipe_close))
                        try: result = g.collect(p, metric, time.monotonic()+3)
                        except BaseException as exc: escaped = type(exc).__name__
                    # Observe without poll, wait or harness teardown.
                    self.assertIsNone(escaped, 'collector escaped without ownership report: '+str(escaped))
                    self.assertEqual(result['pid'], p.pid)
                    self.assertNotEqual(result['status'], 'OK')
                    self.assertTrue(result['reaped'])
                    self.assertIsNotNone(p.returncode, 'candidate must reap original itself')
                    self.assertEqual(result['returncode'], p.returncode)
                    self.assertTrue(p.stdout.closed and p.stderr.closed)
                    if fault in ('selector-close', 'pipe-close'):
                        self.assertEqual(result['stdout'], b'ready\n')
                        self.assertEqual(result['cleanup'], 'UNKNOWN_RETAIN_AND_STOP')
                finally: self.fallback(p, fault)

    def test_main_metric_exception_retains_command_and_reaps_before_return(self):
        import run_probe as r
        import subprocess, tempfile, json
        from unittest.mock import patch
        owner = self
        class Sampler:
            def __init__(self, env): self.calls = 0
            def __call__(self, pid):
                self.calls += 1
                if self.calls > 1: raise subprocess.TimeoutExpired('fixture-metric', 1)
                return owner.metric(pid)
        real_popen = subprocess.Popen
        owned = []
        def python_only(command, **kw):
            p = real_popen([sys.executable, '-B', '-c', 'import time; time.sleep(2)'], **kw)
            owned.append(p)
            return p
        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(r, 'preflight', return_value=({'uid': 501}, Path('/fixture/compiler'), Path('/fixture/sdk'))), patch.object(r, 'DarwinSampler', Sampler), patch.object(r.subprocess, 'Popen', side_effect=python_only):
                out = Path(directory).resolve() / 'run'
                self.assertEqual(r.main(['--out', str(out)]), 3)
                report = json.loads((out / 'result.json').read_text())
                self.assertEqual(report['status'], 'STOP')
                self.assertEqual(len(report['commands']), 1)
                cap = report['commands'][0]
                self.assertEqual(cap['pid'], owned[0].pid)
                self.assertNotEqual(cap['status'], 'OK')
                self.assertTrue(cap['reaped'])
                self.assertIsNotNone(owned[0].returncode)
                self.assertEqual(cap['returncode'], owned[0].returncode)
                self.assertTrue(owned[0].stdout.closed and owned[0].stderr.closed)
                self.assertFalse(report['native_measured'])
        finally:
            for p in owned: self.fallback(p, 'main-metric-timeout')


class ToolOwnershipTests(unittest.TestCase):
    def test_tool_post_spawn_setup_and_teardown_are_owned(self):
        import darwin_guard as g
        import subprocess, os
        from contextlib import ExitStack
        from unittest.mock import patch
        real_popen, real_selector = subprocess.Popen, g.selectors.DefaultSelector
        for fault in ('constructor', 'register', 'nonblocking', 'selector-close', 'pipe-close'):
            with self.subTest(fault=fault):
                owned = []
                def spawn(*a, **kw):
                    p = real_popen(*a, **kw)
                    owned.append(p)
                    if fault == 'pipe-close':
                        close = p.stdout.close
                        def broken():
                            close()
                            raise OSError('pipe-close')
                        stack.enter_context(patch.object(p.stdout, 'close', side_effect=broken))
                    return p
                exc = None
                try:
                    with ExitStack() as stack:
                        stack.enter_context(patch.object(g.subprocess, 'Popen', side_effect=spawn))
                        if fault == 'constructor':
                            stack.enter_context(patch.object(g.selectors, 'DefaultSelector', side_effect=OSError('constructor')))
                        elif fault == 'nonblocking':
                            stack.enter_context(patch.object(g.os, 'set_blocking', side_effect=OSError('nonblocking')))
                        else:
                            sel = real_selector()
                            if fault == 'register':
                                stack.enter_context(patch.object(sel, 'register', side_effect=OSError('register')))
                            if fault == 'selector-close':
                                close = sel.close
                                def broken_close():
                                    close()
                                    raise OSError('selector-close')
                                stack.enter_context(patch.object(sel, 'close', side_effect=broken_close))
                            stack.enter_context(patch.object(g.selectors, 'DefaultSelector', return_value=sel))
                        try:
                            g.small_tool([sys.executable, '-B', '-c', 'import time; print("tool",flush=True); time.sleep(.1)'], dict(os.environ))
                        except BaseException as error: exc = error
                    self.assertIsNotNone(exc)
                    p = owned[0]
                    self.assertIsNotNone(p.returncode, 'tool must be reaped before exception escapes')
                    self.assertTrue(p.stdout.closed and p.stderr.closed)
                    receipt = getattr(exc, 'owned_tool', None)
                    self.assertIsNotNone(receipt, 'upper layer must receive original tool receipt')
                    self.assertEqual(receipt['pid'], p.pid)
                    self.assertTrue(receipt['reaped'])
                    self.assertEqual(receipt['returncode'], p.returncode)
                    self.assertNotEqual(receipt['status'], 'OK')
                finally:
                    for p in owned: ExceptionOwnershipTests.fallback(p, 'tool-'+fault)

    def test_unreaped_tool_is_explicit_in_collector_stop(self):
        import darwin_guard as g
        import subprocess, time, os
        from unittest.mock import patch
        real_popen = subprocess.Popen
        producer = real_popen([sys.executable, '-B', '-c', 'import time; time.sleep(2)'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        tools = []
        def spawn(*a, **kw):
            p = real_popen(*a, **kw)
            tools.append(p)
            return p
        def sample(pid):
            with patch.object(g.subprocess, 'Popen', side_effect=spawn), patch.object(g.selectors, 'DefaultSelector', side_effect=OSError('setup')), patch.object(real_popen, 'kill', return_value=None), patch.object(real_popen, 'wait', side_effect=subprocess.TimeoutExpired('fixture-wait', 1)):
                g.small_tool([sys.executable, '-B', '-c', 'import time; time.sleep(2)'], dict(os.environ))
        result, escaped = None, None
        try:
            try: result = g.collect(producer, sample, time.monotonic()+3)
            except BaseException as exc: escaped = type(exc).__name__
            self.assertIsNone(escaped)
            self.assertNotEqual(result['status'], 'OK')
            self.assertIsNotNone(producer.returncode)
            self.assertTrue(producer.stdout.closed and producer.stderr.closed)
            self.assertEqual(len(result.get('owned_tools', [])), 1)
            tool = result['owned_tools'][0]
            self.assertEqual(tool['pid'], tools[0].pid)
            self.assertFalse(tool['reaped'])
            self.assertIsNone(tools[0].returncode)
            self.assertTrue(tools[0].stdout.closed and tools[0].stderr.closed)
            self.assertEqual(tool['cleanup'], 'UNKNOWN_RETAIN_AND_STOP')
            self.assertEqual(result['cleanup'], 'UNKNOWN_RETAIN_AND_STOP')
        finally:
            ExceptionOwnershipTests.fallback(producer, 'producer-of-unknown-tool')
            for p in tools: ExceptionOwnershipTests.fallback(p, 'deliberately-unreapable-tool-fixture')


class FinalAdmissionTests(unittest.TestCase):
    def test_main_cancellation_during_last_sample_never_dispatches(self):
        self.check_admission('cancel')

    def test_main_virtual_deadline_during_last_sample_never_dispatches(self):
        self.check_admission('deadline')

    def check_admission(self, mode):
        import run_probe as r
        import tempfile, json, signal
        from contextlib import ExitStack
        from unittest.mock import patch
        clock = [100.0]
        handler_seen = []
        original_handler = signal.getsignal(signal.SIGTERM)
        class Sampler:
            def __init__(self, env): pass
            def __call__(self, pid):
                if mode == 'cancel':
                    handler = signal.getsignal(signal.SIGTERM)
                    handler_seen.append(handler)
                    handler(signal.SIGTERM, None)  # actual handler installed by main
                else:
                    # Virtual suspension only; no 293-second wallclock/native run.
                    clock[0] = 393.0  # total deadline 400, final admission cutoff 392
                return ExceptionOwnershipTests.metric(pid)
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            stack.enter_context(patch.object(r, 'preflight', return_value=({'uid': 501}, Path('/fixture/compiler'), Path('/fixture/sdk'))))
            stack.enter_context(patch.object(r, 'DarwinSampler', Sampler))
            if mode == 'deadline': stack.enter_context(patch.object(r.time, 'monotonic', side_effect=lambda: clock[0]))
            spawn = stack.enter_context(patch.object(r.subprocess, 'Popen', side_effect=OSError('native dispatch forbidden by fixture')))
            out = Path(directory).resolve() / 'run'
            self.assertEqual(r.main(['--out', str(out)]), 3)
            doc = json.loads((out / 'result.json').read_text())
            spawn.assert_not_called()
            self.assertEqual(doc['commands'], [])
            self.assertEqual(doc['status'], 'STOP')
            self.assertFalse(doc['native_measured'])
        if mode == 'cancel':
            self.assertEqual(len(handler_seen), 1)
            self.assertNotEqual(handler_seen[0], original_handler)
        self.assertEqual(signal.getsignal(signal.SIGTERM), original_handler)


class PersistenceBoundaryTests(unittest.TestCase):
    def test_command_write_and_collect_faults_preserve_owner_and_raw(self):
        import run_probe as r
        import subprocess, tempfile, json
        from unittest.mock import patch
        from contextlib import ExitStack
        real_popen, real_write, real_bytes, real_collect = subprocess.Popen, r.write_json, Path.write_bytes, r.collect
        for fault in ('dispatch-write', 'raw-write', 'metadata-write', 'collect-escape', 'finish-error'):
            with self.subTest(fault=fault):
                owned, dispatch_seen = [], []
                def python_only(command, **kw):
                    p = real_popen([sys.executable, '-B', '-c', 'import time; print("saved-raw",flush=True); time.sleep(.1)'], **kw)
                    owned.append(p)
                    return p
                class Sampler:
                    def __init__(self, env): pass
                    def __call__(self, pid): return ExceptionOwnershipTests.metric(pid)
                    def finish(self, pid):
                        if fault == 'finish-error': raise OSError('finish')
                        return 'NO_KNOWN_DESCENDANT_IN_SNAPSHOT_NOT_TREE_PROOF'
                def writer(path, value):
                    if path.name == ('compile.dispatched.json' if fault == 'dispatch-write' else 'compile.json' if fault == 'metadata-write' else ''):
                        raise OSError('injected receipt write')
                    return real_write(path, value)
                def bytes_writer(path, value):
                    if fault == 'raw-write' and path.name == 'compile.stdout': raise OSError('injected raw write')
                    return real_bytes(path, value)
                def collector(p, *a, **kw):
                    # Ownership receipt must already exist before ANY dangerous collect.
                    dispatch_seen.append(json.loads((out / 'compile.dispatched.json').read_text()))
                    if fault == 'collect-escape':
                        kw['report']['stdout'] = b'partial-before-exception'
                        raise OSError('escaped collector boundary')
                    return real_collect(p, *a, **kw)
                try:
                    with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                        out = Path(directory).resolve() / 'run'
                        stack.enter_context(patch.object(r, 'preflight', return_value=({'uid': 501}, Path('/fixture/compiler'), Path('/fixture/sdk'))))
                        stack.enter_context(patch.object(r, 'DarwinSampler', Sampler))
                        stack.enter_context(patch.object(r.subprocess, 'Popen', side_effect=python_only))
                        stack.enter_context(patch.object(r, 'write_json', side_effect=writer))
                        stack.enter_context(patch.object(r.Path, 'write_bytes', bytes_writer))
                        stack.enter_context(patch.object(r, 'collect', side_effect=collector))
                        self.assertEqual(r.main(['--out', str(out)]), 3)
                        report = json.loads((out / 'result.json').read_text())
                        cap, p = report['commands'][0], owned[0]
                        self.assertEqual(len(report['commands']), 1)
                        self.assertEqual(cap['pid'], p.pid)
                        self.assertNotEqual(cap['status'], 'OK')
                        self.assertTrue(cap['reaped'])
                        self.assertIsNotNone(p.returncode)
                        self.assertEqual(cap['returncode'], p.returncode)
                        self.assertTrue(p.stdout.closed and p.stderr.closed)
                        self.assertFalse(report['native_measured'])
                        if fault == 'dispatch-write':
                            self.assertFalse(cap.get('dispatch_receipt_written', False))
                            self.assertFalse((out / 'compile.dispatched.json').exists())
                            self.assertEqual(dispatch_seen, [])
                        else:
                            self.assertEqual(dispatch_seen[0]['pid'], p.pid)
                            self.assertEqual(dispatch_seen[0]['status'], 'DISPATCHED')
                            self.assertFalse(dispatch_seen[0]['reaped'])
                            if fault == 'raw-write':
                                self.assertEqual(bytes.fromhex(cap['unwritten_raw_hex']['stdout']), b'saved-raw\n')
                                self.assertFalse((out / 'compile.stdout').exists())
                                self.assertTrue((out / 'compile.stderr').exists())
                            else:
                                expected = b'partial-before-exception' if fault == 'collect-escape' else b'saved-raw\n'
                                self.assertEqual((out / 'compile.stdout').read_bytes(), expected)
                finally:
                    for p in owned: ExceptionOwnershipTests.fallback(p, fault)

    def test_original_unreapable_and_secondary_close_error_are_explicit(self):
        import darwin_guard as g
        import subprocess, time
        from unittest.mock import patch
        p = subprocess.Popen([sys.executable, '-B', '-c', 'import time; time.sleep(2)'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        real_close = p.stdout.close
        def broken_close():
            real_close()
            raise OSError('secondary close')
        try:
            with patch.object(g.selectors, 'DefaultSelector', side_effect=ValueError('primary setup')), patch.object(p, 'send_signal', return_value=None) as signals, patch.object(p, 'wait', side_effect=subprocess.TimeoutExpired('fixture', 1)), patch.object(p.stdout, 'close', side_effect=broken_close):
                cap = g.collect(p, ExceptionOwnershipTests.metric, time.monotonic()+3)
            self.assertEqual(cap['status'], 'COLLECT_ERROR')
            self.assertEqual(cap['errors'][0], {'phase': 'COLLECT', 'type': 'ValueError'})
            self.assertEqual([e['phase'] for e in cap['errors']], ['COLLECT', 'REAP', 'STDOUT_CLOSE'])
            self.assertFalse(cap['reaped'])
            self.assertIsNone(cap['returncode'])
            self.assertIsNone(p.returncode)
            self.assertTrue(p.stdout.closed and p.stderr.closed)
            self.assertEqual(cap['cleanup'], 'UNKNOWN_RETAIN_AND_STOP')
            self.assertEqual([call.args[0] for call in signals.call_args_list], [g.signal.SIGTERM])
        finally: ExceptionOwnershipTests.fallback(p, 'deliberately-unreapable-original-fixture')


class RemainingOwnershipTests(unittest.TestCase):
    def test_collect_cleanup_does_not_extend_reserved_total_deadline(self):
        import darwin_guard as g
        import subprocess
        from unittest.mock import patch
        p = subprocess.Popen([sys.executable, '-B', '-c', 'import time; time.sleep(2)'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        wait = p.wait
        try:
            # Synthetic clock: collect deadline 393 + reserved 7 = total 400.
            with patch.object(g.time, 'monotonic', return_value=399.0), patch.object(g.selectors, 'DefaultSelector', side_effect=OSError('setup')), patch.object(p, 'wait', wraps=wait) as waiting:
                cap = g.collect(p, ExceptionOwnershipTests.metric, 393.0)
            self.assertTrue(cap['reaped'])
            self.assertIsNotNone(p.returncode)
            self.assertTrue(p.stdout.closed and p.stderr.closed)
            self.assertLessEqual(waiting.call_args.kwargs['timeout'], 1.0)
        finally: ExceptionOwnershipTests.fallback(p, 'virtual-total-deadline-cleanup')

    def test_main_actual_collector_setup_and_read_errors_retain_ledger(self):
        import run_probe as r
        import darwin_guard as g
        import subprocess, tempfile, json
        from unittest.mock import patch
        from contextlib import ExitStack
        real_popen, real_selector = subprocess.Popen, g.selectors.DefaultSelector
        for fault in ('constructor', 'register', 'nonblocking', 'read', 'result-write'):
            with self.subTest(fault=fault):
                owned, final_reports = [], []
                class Sampler:
                    def __init__(self, env): pass
                    def __call__(self, pid): return ExceptionOwnershipTests.metric(pid)
                    def finish(self, pid): raise g.GuardError('FIXTURE_FINISH_STOP')
                def spawn(command, **kw):
                    p = real_popen([sys.executable, '-B', '-c', 'import time; print("ready",flush=True); time.sleep(.1)'], **kw)
                    owned.append(p)
                    if fault == 'constructor':
                        stack.enter_context(patch.object(g.selectors, 'DefaultSelector', side_effect=OSError('setup')))
                    elif fault == 'register':
                        sel = real_selector()
                        stack.enter_context(patch.object(sel, 'register', side_effect=OSError('register')))
                        stack.enter_context(patch.object(g.selectors, 'DefaultSelector', return_value=sel))
                    elif fault == 'nonblocking':
                        stack.enter_context(patch.object(g.os, 'set_blocking', side_effect=OSError('nonblocking')))
                    elif fault == 'read':
                        stack.enter_context(patch.object(g.os, 'read', side_effect=OSError('read')))
                    return p
                write = r.write_json
                def writer(path, value):
                    if path.name == 'result.json':
                        final_reports.append(value)
                        if fault == 'result-write': raise OSError('final evidence unavailable')
                    return write(path, value)
                try:
                    with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                        stack.enter_context(patch.object(r, 'preflight', return_value=({'uid': 501}, Path('/fixture/compiler'), Path('/fixture/sdk'))))
                        stack.enter_context(patch.object(r, 'DarwinSampler', Sampler))
                        stack.enter_context(patch.object(r.subprocess, 'Popen', side_effect=spawn))
                        stack.enter_context(patch.object(r, 'write_json', side_effect=writer))
                        out = Path(directory).resolve() / 'run'
                        if fault == 'result-write':
                            with self.assertRaises(OSError): r.main(['--out', str(out)])
                            self.assertFalse((out / 'result.json').exists())
                        else:
                            self.assertEqual(r.main(['--out', str(out)]), 3)
                            self.assertEqual(json.loads((out / 'result.json').read_text())['status'], 'STOP')
                        cap = final_reports[0]['commands'][0]
                        p = owned[0]
                        self.assertEqual(cap['pid'], p.pid)
                        self.assertNotEqual(cap['status'], 'OK')
                        self.assertTrue(cap['reaped'])
                        self.assertIsNotNone(p.returncode)
                        self.assertEqual(cap['returncode'], p.returncode)
                        self.assertTrue(p.stdout.closed and p.stderr.closed)
                finally:
                    for p in owned: ExceptionOwnershipTests.fallback(p, 'main-'+fault)


class PreflightDiagnosticTests(unittest.TestCase):
    """Portable synthetic observations; real preflight/main/writers, zero dispatch."""
    def boundaries(self, stack, sample):
        import run_probe as r
        from types import SimpleNamespace
        from unittest.mock import Mock, patch
        real_path = Path
        dev = Mock()
        dev.name = 'CommandLineTools'
        dev.__truediv__ = Mock(return_value=dev)
        dev.is_file.return_value = dev.is_dir.return_value = True
        dev.resolve.return_value = dev
        dev.stat.return_value = SimpleNamespace(st_uid=0, st_mode=0o755)
        sampler = Mock(return_value=sample)
        sampler.identity.return_value = SimpleNamespace(svuid=501, svgid=20)
        for obj, name, value in ((r.platform, 'system', 'Darwin'),
                                 (r.platform, 'machine', 'arm64'),
                                 (r.os, 'getuid', 501), (r.os, 'geteuid', 501),
                                 (r.os, 'getgid', 20), (r.os, 'getegid', 20),
                                 (r.os, 'access', True), (r, 'ctypes_issetugid', 0)):
            stack.enter_context(patch.object(obj, name, return_value=value))
        # Only the two SDK-choice roots are synthetic; output/source paths stay real.
        stack.enter_context(patch.object(r, 'Path', side_effect=lambda value:
            dev if str(value) in ('/Library/Developer/CommandLineTools',
                                 '/Applications/Xcode.app/Contents/Developer') else real_path(value)))
        factory = stack.enter_context(patch.object(r, 'DarwinSampler', return_value=sampler))
        spawn = stack.enter_context(patch.object(r.subprocess, 'Popen', side_effect=AssertionError('native forbidden')))
        tool = stack.enter_context(patch.object(r, 'small_tool', side_effect=AssertionError('OS tool forbidden')))
        return sampler, factory, spawn, tool, dev

    def run_resource(self, free, rss):
        import run_probe as r
        import io, json, tempfile
        from contextlib import ExitStack, redirect_stdout
        from unittest.mock import patch
        sample = {'free': free, 'rss': rss, 'identity': ('PRIVATE_PID', 1),
                  'descendants': ['PRIVATE_DESCENDANT'], 'env': 'PRIVATE_ENV',
                  'host': 'PRIVATE_HOST', 'sdk': 'PRIVATE_SDK', 'path': 'PRIVATE_PATH'}
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            out = Path(directory).resolve() / 'receipt'
            # Output admission is tested elsewhere; keep its real ownership checks
            # outside synthetic credentials while retaining real owned_output.
            admit = r.owned_output
            admitted = admit(str(out))
            sampler, factory, spawn, tool, dev = self.boundaries(stack, sample)
            stack.enter_context(patch.object(r, 'owned_output', return_value=admitted))
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                self.assertEqual(r.main(['--out', str(out)]), 3)
            report = json.loads((out / 'result.json').read_text())
            public = json.loads((out / 'shareable-summary.json').read_text())
            self.assertEqual(json.loads(stdout.getvalue()), public)
            factory.assert_called_once()
            sampler.assert_called_once_with(r.os.getpid())
            spawn.assert_not_called()
            tool.assert_not_called()
            self.assertEqual(report['status'], 'STOP')
            self.assertEqual(report['stop_reason'], 'PREFLIGHT_RESOURCE')
            self.assertEqual(report['commands'], [])
            self.assertIsNone(report['host'])
            self.assertFalse(report['native_measured'])
            self.assertTrue(all(c['status'] == 'NOT_RUN' for c in report['cases']))
            self.assertIn('preflight_resource', report, 'same failing sample receipt missing')
            expected = {'schema': 1, 'stage': 'PREFLIGHT_RESOURCE', 'units': 'bytes',
                        'free_bytes': free, 'rss_bytes': rss,
                        'reserve_bytes': 1024*r.MIB, 'rss_limit_bytes': 384*r.MIB,
                        'free_below_reserve': free < 1024*r.MIB,
                        'rss_above_limit': rss > 384*r.MIB, 'sample_timing': 'NOT_CAPTURED'}
            self.assertEqual(report['preflight_resource'], expected)
            self.assertEqual(public['preflight_resource'], expected)
            self.assertNotIn('preflight_resource', json.loads((out / 'started.json').read_text()))
            self.assertNotIn('PRIVATE_', json.dumps(public, allow_nan=False))
            return report, public

    def test_free_only_same_sample_receipt_through_real_main(self):
        import run_probe as r
        self.run_resource(1024*r.MIB-1, 384*r.MIB)


    def test_rss_both_and_zero_are_observations_not_missing(self):
        import run_probe as r
        import json
        for free, rss in ((1024*r.MIB, 384*r.MIB+1),
                          (1024*r.MIB-1, 384*r.MIB+1), (0, 0)):
            with self.subTest(free=free, rss=rss):
                report, public = self.run_resource(free, rss)
                self.assertEqual(set(public), {'schema', 'status', 'native_measured',
                    'source_sha256', 'binary_sha256', 'case_status', 'not_run',
                    'exit_code', 'product_gate_changed', 'privacy', 'preflight_resource'})
                print(json.dumps({'portable_synthetic_public': public}, allow_nan=False))

    def test_exact_thresholds_preflight_positive_control_without_dispatch(self):
        import run_probe as r
        from contextlib import ExitStack
        from unittest.mock import patch
        for free, rss in ((1024*r.MIB, 384*r.MIB), (1024*r.MIB+1, 384*r.MIB-1)):
            with self.subTest(free=free, rss=rss), ExitStack() as stack:
                sample = {'free': free, 'rss': rss}
                sampler, factory, spawn, tool, dev = self.boundaries(stack, sample)
                tool.side_effect = None
                tool.return_value = 'synthetic version'
                stack.enter_context(patch.object(r, 'sha', return_value='synthetic hash'))
                stack.enter_context(patch.object(r.resource, 'getrlimit', return_value=(10, 10)))
                host, compiler, sdk = r.preflight({})
                self.assertEqual(host['system'], 'Darwin')
                self.assertNotIn('preflight_resource', host)
                self.assertIs(compiler, dev)
                self.assertIs(sdk, dev)
                self.assertEqual(sample, {'free': free, 'rss': rss})
                sampler.assert_called_once_with(r.os.getpid())
                factory.assert_called_once()
                spawn.assert_not_called()

    def test_other_rejections_missing_and_unusable_samples_do_not_fabricate(self):
        import run_probe as r
        import io, json, tempfile, subprocess, signal
        from contextlib import ExitStack, redirect_stdout
        from unittest.mock import patch
        modes = ('sdk', 'identity', 'metric', 'timeout', 'oserror', 'valueerror',
                 'missing-free', 'missing-rss', 'none-free', 'bool', 'nan-rss',
                 'huge-rss', 'negative-rss', 'forged-error')
        for mode in modes:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                out = Path(directory).resolve() / 'run'
                admitted = r.owned_output(str(out))
                sample = {'free': 0, 'rss': 1}
                if mode == 'missing-free': sample.pop('free')
                if mode == 'missing-rss': sample.pop('rss')
                if mode == 'none-free': sample['free'] = None
                if mode == 'bool': sample['free'] = False
                if mode == 'nan-rss': sample['rss'] = float('nan')
                if mode == 'huge-rss': sample['rss'] = 2**63
                if mode == 'negative-rss': sample['rss'] = -1
                sampler, factory, spawn, tool, dev = self.boundaries(stack, sample)
                stack.enter_context(patch.object(r, 'owned_output', return_value=admitted))
                expected = 'PREFLIGHT_RESOURCE'
                if mode == 'sdk':
                    dev.is_file.return_value = False
                    expected = 'EXISTING_APPLE_COMPILER_SDK_REQUIRED'
                if mode == 'identity':
                    sampler.identity.return_value.svuid = 0
                    expected = 'SAVED_CREDENTIAL_MISMATCH'
                faults = {'metric': r.GuardError('FREE_METRIC_MALFORMED'),
                          'timeout': subprocess.TimeoutExpired('PRIVATE_PATH', 1),
                          'oserror': OSError('PRIVATE_PATH'), 'valueerror': ValueError('PRIVATE_PATH'),
                          'forged-error': r.ProbeError('PREFLIGHT_RESOURCE')}
                if mode in faults:
                    error = faults[mode]
                    error.preflight_resource = {'free_bytes': 0, 'env': 'PRIVATE_ENV'}
                    if mode == 'metric': error.owned_tool = {'cleanup': 'UNKNOWN_RETAIN_AND_STOP', 'pid': 'PRIVATE_PID'}
                    sampler.side_effect = error
                    expected = str(error) if isinstance(error, (r.ProbeError, r.GuardError)) else type(error).__name__
                previous = signal.getsignal(signal.SIGTERM)
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    if mode in ('missing-free', 'none-free'):
                        with self.assertRaises(KeyError if mode == 'missing-free' else TypeError):
                            r.main(['--out', str(out)])
                    else:
                        self.assertEqual(r.main(['--out', str(out)]), 3)
                report = json.loads((out / 'result.json').read_text())
                public = json.loads((out / 'shareable-summary.json').read_text())
                self.assertEqual(json.loads(stdout.getvalue()), public)
                for doc in (report, public): self.assertNotIn('preflight_resource', doc)
                if mode not in ('missing-free', 'none-free'):
                    self.assertEqual(report['status'], 'STOP')
                    self.assertEqual(report['stop_reason'], expected)
                else:
                    # Preserve existing uncaught metric exception semantics, not a new catch.
                    self.assertEqual(report['status'], 'IN_PROGRESS')
                if mode == 'metric': self.assertEqual(report['owned_tools'], [faults[mode].owned_tool])
                self.assertNotIn('PRIVATE_', json.dumps(public, allow_nan=False))
                self.assertEqual(report['commands'], [])
                self.assertFalse(report['native_measured'])
                self.assertTrue(all(c['status'] == 'NOT_RUN' for c in report['cases']))
                self.assertEqual(sampler.call_count, 0 if mode in ('sdk', 'identity') else 1)
                self.assertEqual(signal.getsignal(signal.SIGTERM), previous)
                spawn.assert_not_called()
                tool.assert_not_called()

    def test_final_receipt_writes_fail_without_false_durability_or_dispatch(self):
        import run_probe as r
        import io, json, tempfile, signal
        from contextlib import ExitStack, redirect_stdout
        from unittest.mock import patch
        for filename in ('result.json', 'shareable-summary.json'):
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                out = Path(directory).resolve() / 'run'
                admitted = r.owned_output(str(out))
                sampler, factory, spawn, tool, dev = self.boundaries(stack, {'free': 0, 'rss': 0})
                stack.enter_context(patch.object(r, 'owned_output', return_value=admitted))
                write = r.write_json
                attempted = []
                def writer(path, value):
                    attempted.append(path.name)
                    if path.name == filename: raise OSError('storage unavailable')
                    return write(path, value)
                stack.enter_context(patch.object(r, 'write_json', side_effect=writer))
                stdout = io.StringIO()
                previous = signal.getsignal(signal.SIGTERM)
                with redirect_stdout(stdout), self.assertRaisesRegex(OSError, 'storage unavailable'):
                    r.main(['--out', str(out)])
                self.assertEqual(stdout.getvalue(), '')
                self.assertFalse((out / filename).exists())
                self.assertTrue((out / 'started.json').exists())
                self.assertEqual(attempted, ['started.json', 'result.json'] +
                                 (['shareable-summary.json'] if filename == 'shareable-summary.json' else []))
                if filename == 'result.json': self.assertFalse((out / 'shareable-summary.json').exists())
                else: self.assertEqual(json.loads((out / 'result.json').read_text())['preflight_resource']['free_bytes'], 0)
                self.assertEqual(signal.getsignal(signal.SIGTERM), previous)
                sampler.assert_called_once()
                spawn.assert_not_called()
                tool.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
