'use strict';

// The public repo ships as OpenCoach. Ports from the private repo replace apps/web/index.html
// wholesale, so guard the visible brand (title + header) here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('web interface shows the OpenCoach brand', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'index.html'), 'utf8');
  assert.match(html, /<title>OpenCoach\b[^<]*<\/title>/);
  assert.match(html, /<div class="brand">OpenCoach<\/div>/);
});
