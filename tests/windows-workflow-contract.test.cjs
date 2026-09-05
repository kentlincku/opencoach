const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('Windows workflow runs for relevant pull requests', () => {
  const workflow = read('.github/workflows/windows-beta.yml');
  assert.match(workflow, /\bpull_request:/);
  for (const expectedPath of [
    '.github/workflows/windows-beta.yml',
    'tests/windows-*.test.cjs',
    'scripts/*windows*.ps1',
    'package.json',
    'package-lock.json',
  ]) {
    assert.ok(workflow.includes(`'${expectedPath}'`) || workflow.includes(`"${expectedPath}"`), `missing PR path: ${expectedPath}`);
  }
});

test('Windows workflow enumerates Node files instead of passing wildcard literals', () => {
  const workflow = read('.github/workflows/windows-beta.yml');
  assert.doesNotMatch(workflow, /node --check[^\r\n]*\*/);
  assert.match(workflow, /Get-ChildItem/);
  assert.match(workflow, /node --check \$file\.FullName/);
});

test('workflow input reaches PowerShell through an environment variable', () => {
  const workflow = read('.github/workflows/windows-beta.yml');
  assert.match(workflow, /BUILD_LABEL:\s*\$\{\{\s*inputs\.label\s*\}\}/);
  assert.match(workflow, /\$env:BUILD_LABEL/);
  assert.doesNotMatch(workflow, /\$label\s*=\s*['"]\$\{\{/);
});

test('Windows source verification does not publish engineering binaries', () => {
  const workflow = read('.github/workflows/windows-beta.yml');
  assert.doesNotMatch(workflow, /upload-artifact/);
  assert.doesNotMatch(workflow, /retention-days/);
});

test('shared credential regression tests remain intact', () => {
  const source = read('tests/credential-store.test.cjs');
  for (const title of [
    'stores encrypted provider credential atomically without plaintext',
    'uses 0600 credential file permissions on POSIX',
    'clear removes credential without returning plaintext',
  ]) {
    assert.ok(source.includes(title), `missing shared regression test: ${title}`);
  }
});

test('provider routing contracts use only the Windows-prefixed additive file', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'tests/provider-routing.test.cjs')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'tests/windows-provider-routing.test.cjs')), true);
});
