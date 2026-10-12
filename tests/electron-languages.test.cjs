'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const yml = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
const block = yml.match(/^electronLanguages:\n((?:\s+- .+\n)+)/m);
const langs = block ? block[1].split('\n').map(l => l.replace(/^\s+-\s+/, '').trim()).filter(Boolean) : [];

test('electronLanguages keeps the macOS .lproj names (en, zh_TW)', () => {
  assert.ok(langs.includes('en') && langs.includes('zh_TW'), JSON.stringify(langs));
});

test('electronLanguages keeps the Windows locales/*.pak names (en-US, zh-TW); none left breaks the renderer', () => {
  assert.ok(langs.includes('en-US') && langs.includes('zh-TW'), JSON.stringify(langs));
});
