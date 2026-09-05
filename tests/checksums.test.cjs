const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('checksum manifest contains only uploaded release artifact types', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'release-checksums-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await Promise.all([
    fs.writeFile(path.join(directory, 'Voice Practice.dmg'), 'dmg'),
    fs.writeFile(path.join(directory, 'Voice Practice.zip'), 'zip'),
    fs.writeFile(path.join(directory, 'Voice Practice.exe'), 'exe'),
    fs.writeFile(path.join(directory, 'builder-debug.yml'), 'debug'),
    fs.writeFile(path.join(directory, 'latest.yml'), 'metadata'),
    fs.writeFile(path.join(directory, 'Voice Practice.exe.blockmap'), 'blockmap'),
  ]);

  const result = spawnSync(process.execPath, ['scripts/write-checksums.mjs', directory], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await fs.readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8');
  assert.match(manifest, /Voice Practice\.dmg/);
  assert.match(manifest, /Voice Practice\.zip/);
  assert.match(manifest, /Voice Practice\.exe/);
  assert.doesNotMatch(manifest, /builder-debug|latest\.yml|blockmap/);
});
