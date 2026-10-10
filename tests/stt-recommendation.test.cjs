'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recommendSttTier, tierWarning, detectAvx2, TIERS } = require('../apps/desktop/stt-recommendation.cjs');
const GiB = 1024 ** 3;

test('macOS: 16 GB and above recommends accurate; 8 GB recommends fast', () => {
  assert.equal(recommendSttTier({ platform: 'darwin', arch: 'arm64', totalMemBytes: 48 * GiB }).tier, 'accurate');
  assert.equal(recommendSttTier({ platform: 'darwin', arch: 'arm64', totalMemBytes: 16 * GiB }).tier, 'accurate');
  assert.equal(recommendSttTier({ platform: 'darwin', arch: 'arm64', totalMemBytes: 8 * GiB }).tier, 'fast');
});

test('Windows: AVX2 + 16 GB -> balanced, AVX2 + 8 GB -> fast, otherwise ultrafast; never accurate', () => {
  const w = (gb, avx2) => recommendSttTier({ platform: 'win32', arch: 'x64', totalMemBytes: Math.round(gb * GiB), avx2 }).tier;
  assert.equal(w(31.7, true), 'balanced');
  assert.equal(w(15.8, true), 'balanced');
  assert.equal(w(7.9, true), 'fast');
  assert.equal(w(4, true), 'ultrafast');
  assert.equal(w(64, false), 'ultrafast');
  assert.equal(w(64, null), 'ultrafast');
  for (const gb of [4, 8, 16, 64, 256]) assert.notEqual(w(gb, true), 'accurate');
});

test('unknown platform or memory is conservative', () => {
  assert.equal(recommendSttTier({ platform: 'linux', arch: 'x64', totalMemBytes: 64 * GiB }).tier, 'ultrafast');
  assert.equal(recommendSttTier({ platform: 'darwin', arch: 'x64', totalMemBytes: 64 * GiB }).tier, 'ultrafast');
  for (const bad of [0, -1, NaN, '16', undefined, 2 ** 60]) {
    assert.equal(recommendSttTier({ platform: 'darwin', arch: 'arm64', totalMemBytes: bad }).tier, 'ultrafast');
  }
});

test('accurate on Windows CPU carries a slowness warning', () => {
  assert.equal(tierWarning('win32', 'accurate'), 'CPU_SLOW_ACCURATE');
  for (const tier of TIERS.filter(t => t !== 'accurate')) assert.equal(tierWarning('win32', tier), null);
  assert.equal(tierWarning('darwin', 'accurate'), null);
});

test('AVX2 heuristic: known families true, older or unknown false', () => {
  const m = model => detectAvx2([{ model }]);
  assert.equal(m('12th Gen Intel(R) Core(TM) i7-12700K'), true);
  assert.equal(m('Intel(R) Core(TM) i7-4770 CPU @ 3.40GHz'), true);
  assert.equal(m('Intel(R) Core(TM) Ultra 7 155H'), true);
  assert.equal(m('Intel(R) Core(TM) 7 150U'), true);
  assert.equal(m('AMD Ryzen 7 5800X 8-Core Processor'), true);
  assert.equal(m('Intel(R) Core(TM) i5-2500 CPU @ 3.30GHz'), false);
  assert.equal(m('Intel(R) Celeron(R) N4020'), false);
  assert.equal(m(''), null);
  assert.equal(detectAvx2([]), null);
  assert.equal(detectAvx2(undefined), null);
});
