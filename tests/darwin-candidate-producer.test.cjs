'use strict';

// TEST_ONLY / NON_NATIVE. The old inventory controls are retained in the
// fixed review packet. These tests cover the repaired producer -> shared
// consumer -> real-tree readback chain.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'spikes/packaged-runtime/darwin-candidate-cli.sh');
const PRODUCER = path.join(ROOT, 'spikes/packaged-runtime/darwin_candidate.py');
const VALIDATOR = path.join(ROOT, 'scripts/validate-darwin-candidate-r23.cjs');
const REVISION = '7ba83b893f0985bec851c907a77209a24bead667';
const SOURCE_URL = 'https://example.invalid/r23-source';
const LICENSE_URL = 'https://example.invalid/r23-license';

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r23b-candidate-'));
  fs.chmodSync(root, 0o700);
  return root;
}

function inputRoot(base) {
  const root = path.join(base, 'input');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'models/mlx-whisper'), { recursive: true });
  fs.mkdirSync(path.join(root, 'models/kokoro-onnx'), { recursive: true });
  return root;
}

function completeInput(base) {
  const root = inputRoot(base);
  for (const [relative, contents] of [
    ['bin/voice-runtime', 'runtime fixture'],
    ['models/mlx-whisper/config.json', '{}'],
    ['models/kokoro-onnx/model.onnx', 'onnx fixture'],
    ['models/kokoro-onnx/voices.bin', 'voices fixture'],
    ['LICENSE', 'MIT fixture'],
    ['NOTICE', 'notice fixture'],
  ]) {
    fs.writeFileSync(path.join(root, relative), contents, { mode: 0o600 });
  }
  return root;
}

function runCandidate(root, output) {
  return spawnSync('bash', [CLI, root, output, REVISION, SOURCE_URL, 'MIT', LICENSE_URL], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
}

function runValidator(root, output) {
  return spawnSync(process.execPath, [VALIDATOR, '--input-root', root, '--candidate', output], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
}

test('empty local tree is explicitly INPUTS_MISSING after consumer readback', () => {
  const base = fixture();
  const root = inputRoot(base);
  const output = path.join(base, 'candidate.json');
  const result = runCandidate(root, output);
  assert.equal(result.status, 0, result.stderr);
  const candidate = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(candidate.status, 'INPUTS_MISSING');
  assert.equal(candidate.label, 'CANDIDATE_NOT_TRUSTED');
  assert.equal(candidate.platform, 'darwin');
  assert.equal(candidate.arch, 'arm64');
  assert.deepEqual(candidate.files, []);
  assert.equal(candidate.archive.sha256, null);
});

test('complete synthetic profile uses the real packaged backend roles but remains untrusted', () => {
  const base = fixture();
  const root = completeInput(base);
  const output = path.join(base, 'candidate.json');
  const result = runCandidate(root, output);
  assert.equal(result.status, 0, result.stderr);
  const candidate = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(candidate.status, 'CANDIDATE_NOT_TRUSTED');
  assert.equal(candidate.contract, 'R23_DARWIN_CANDIDATE_V2');
  assert.equal(candidate.entrypoint, 'bin/voice-runtime');
  assert.deepEqual(candidate.modelBindings, {
    sttRoot: { path: 'models/mlx-whisper' },
    onnxModel: { path: 'models/kokoro-onnx/model.onnx' },
    onnxVoices: { path: 'models/kokoro-onnx/voices.bin' },
  });
  assert.equal(candidate.provenance.sourceVerification, 'UNVERIFIED');
  assert.equal(candidate.provenance.license.verification, 'UNVERIFIED');
  assert.equal(candidate.provenance.notice.status, 'PRESENT');
  assert.equal(Object.hasOwn(candidate, 'sha256'), false);
});

test('profile missing a required role remains INPUTS_MISSING and is not promoted by an entrypoint label', () => {
  const base = fixture();
  const root = inputRoot(base);
  fs.writeFileSync(path.join(root, 'asset.bin'), 'only one unrelated file');
  const output = path.join(base, 'candidate.json');
  const result = runCandidate(root, output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).status, 'INPUTS_MISSING');
});

test('input-root symlink is rejected before canonicalization', () => {
  const base = fixture();
  const real = completeInput(base);
  const linked = path.join(base, 'linked-input');
  fs.symlinkSync(real, linked, 'dir');
  const result = runCandidate(linked, path.join(base, 'candidate.json'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink|input root/i);
});

test('hardlink input is rejected by producer and cannot enter the candidate fileset', () => {
  const base = fixture();
  const root = completeInput(base);
  fs.linkSync(path.join(root, 'NOTICE'), path.join(root, 'NOTICE-copy'));
  const result = runCandidate(root, path.join(base, 'candidate.json'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hardlink/i);
});

const canCreateDirectoryCaseCollision = (() => {
  const base = fixture();
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'A'));
  try {
    fs.mkdirSync(path.join(root, 'a'));
    return true;
  } catch {
    return false;
  }
})();

test('directory-node case collision is rejected on a case-sensitive fixture filesystem', { skip: !canCreateDirectoryCaseCollision }, () => {
  const base = fixture();
  const root = completeInput(base);
  fs.mkdirSync(path.join(root, 'A'));
  fs.mkdirSync(path.join(root, 'a'));
  fs.writeFileSync(path.join(root, 'A', 'one'), '1');
  fs.writeFileSync(path.join(root, 'a', 'two'), '2');
  const result = runCandidate(root, path.join(base, 'candidate.json'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /collision/i);
});

test('short OS writes are completed before strict consumer readback', () => {
  const base = fixture();
  const root = completeInput(base);
  const output = path.join(base, 'candidate.json');
  const script = `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('candidate', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
original = module.os.write
module.os.write = lambda fd, data: original(fd, data[:1])
module.produce(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), {
  'sourceRevision': '${REVISION}', 'sourceUrl': '${SOURCE_URL}',
  'license': {'spdx': 'MIT', 'url': '${LICENSE_URL}'},
})
`;
  const produced = spawnSync('python3', ['-I', '-B', '-c', script, PRODUCER, root, output], { encoding: 'utf8', timeout: 15000 });
  assert.equal(produced.status, 0, produced.stderr);
  const verified = runValidator(root, output);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).status, 'CANDIDATE_NOT_TRUSTED');
});

test('changed and extra files fail the real consumer after producer success', () => {
  const base = fixture();
  const root = completeInput(base);
  const output = path.join(base, 'candidate.json');
  assert.equal(runCandidate(root, output).status, 0);
  fs.writeFileSync(path.join(root, 'NOTICE'), 'changed after inventory');
  assert.notEqual(runValidator(root, output).status, 0);
  fs.writeFileSync(path.join(root, 'NOTICE'), 'notice fixture');
  fs.writeFileSync(path.join(root, 'extra.bin'), 'unlisted');
  assert.notEqual(runValidator(root, output).status, 0);
});

test('Python producer rejects output parent replacement and keeps the original partial', () => {
  const base = fixture();
  const root = completeInput(base);
  const output = path.join(base, 'output', 'candidate.json');
  const script = `
import importlib.util, pathlib, sys, os, json
spec = importlib.util.spec_from_file_location('candidate', sys.argv[1])
module = importlib.util.module_from_spec(spec); module_spec = spec.loader.exec_module(module)
b = pathlib.Path(sys.argv[2]); root = b / 'input'; parent = b / 'output'; parent.mkdir(mode=0o700)
out = parent / 'candidate.json'
p = {'sourceRevision': '${REVISION}', 'sourceUrl': '${SOURCE_URL}', 'license': {'spdx': 'MIT', 'url': '${LICENSE_URL}'}}
module.produce(root, parent / 'positive.json', p)
original = module.os.open; reached = False
def controlled(file, *args, **kwargs):
    global reached
    if pathlib.Path(file).name == out.name and kwargs.get('dir_fd') is not None:
        reached = True
        parent.rename(b / 'original-output')
        parent.mkdir(mode=0o700)
        parent.chmod(0o777)
    return original(file, *args, **kwargs)
module.os.open = controlled
caught = False
try:
    module.produce(root, out, p)
except Exception:
    caught = True
finally:
    module.os.open = original
old = b / 'original-output' / 'candidate.json'
print(json.dumps({'reached': reached, 'caught': caught, 'replacementMode': oct(parent.stat().st_mode & 0o777), 'replacementOutput': out.exists(), 'originalPartial': old.exists(), 'partialBytes': old.stat().st_size if old.exists() else None}))
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', script, PRODUCER, base], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const observation = JSON.parse(result.stdout);
  assert.equal(observation.reached, true);
  assert.equal(observation.caught, true);
  assert.equal(observation.replacementMode, '0o777');
  assert.equal(observation.replacementOutput, false);
  assert.equal(observation.originalPartial, true);
});

test('candidate JSON readback is bounded to the writer FD and private output parent', () => {
  const source = fs.readFileSync(PRODUCER, 'utf8');
  const start = source.indexOf('def _read_candidate(');
  const end = source.indexOf('\ndef produce(', start);
  assert.ok(start >= 0 && end > start);
  const reader = source.slice(start, end);
  assert.match(reader, /os\.fstat\(fd\)/);
  assert.match(reader, /os\.read\(fd, CHUNK\)/);
  assert.match(reader, /_same_identity\(opened, after\)/);
  assert.doesNotMatch(reader, /_read_file\(path\)/);
  assert.match(source, /_open_private_parent\(output\.parent\)/);
  assert.match(source, /dir_fd=parent_fd/);
  assert.match(source, /MAX_CANDIDATE_JSON_BYTES/);
  assert.match(source, /outside source repository/);
});

test('candidate metadata growth is rejected by its explicit JSON bound', () => {
  const base = fixture();
  const root = completeInput(base);
  const output = path.join(base, 'candidate.json');
  const script = `
import importlib.util, pathlib, sys, json
spec = importlib.util.spec_from_file_location('candidate', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.MAX_CANDIDATE_JSON_BYTES = 1
try:
  module.produce(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), {
    'sourceRevision': '${REVISION}', 'sourceUrl': '${SOURCE_URL}',
    'license': {'spdx': 'MIT', 'url': '${LICENSE_URL}'},
  })
except Exception as error:
  print(json.dumps({'caught': True, 'message': str(error), 'outputExists': pathlib.Path(sys.argv[3]).exists()}))
else:
  print(json.dumps({'caught': False, 'outputExists': pathlib.Path(sys.argv[3]).exists()}))
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', script, PRODUCER, root, output], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const observation = JSON.parse(result.stdout);
  assert.equal(observation.caught, true);
  assert.match(observation.message, /bounded JSON limit/);
  assert.equal(observation.outputExists, false);
});
