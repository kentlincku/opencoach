const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', 'apps', 'web', 'runtime', 'lesson-library.js');

function storage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

const defaults = [{
  id: 'intro', title: 'Introductions', level: 'Beginner',
  objectives: ['Introduce yourself'], opening_line: 'Hello! Please introduce yourself.'
}];

test('initializes local lesson library from defaults only once', () => {
  delete require.cache[MODULE];
  const library = require(MODULE);
  const local = storage();
  assert.deepEqual(library.loadLessons(local, defaults), defaults);
  assert.deepEqual(JSON.parse(local.getItem(library.STORAGE_KEY)), defaults);
  local.setItem(library.STORAGE_KEY, JSON.stringify([{ ...defaults[0], title: 'Custom' }]));
  assert.equal(library.loadLessons(local, defaults)[0].title, 'Custom');
});

test('validates import schema and rejects duplicate or oversized lessons', () => {
  delete require.cache[MODULE];
  const library = require(MODULE);
  assert.throws(() => library.parseLessonImport('{"schemaVersion":1,"lessons":"bad"}'), /LESSONS_REQUIRED/);
  assert.throws(() => library.parseLessonImport(JSON.stringify({ schemaVersion: 1, lessons: [defaults[0], defaults[0]] })), /DUPLICATE_LESSON_ID/);
  assert.throws(() => library.parseLessonImport(JSON.stringify({ schemaVersion: 1, lessons: [{ ...defaults[0], title: 'x'.repeat(121) }] })), /INVALID_LESSON_TITLE/);
});

test('supports replace, merge, and stable versioned export', () => {
  delete require.cache[MODULE];
  const library = require(MODULE);
  const imported = [{ ...defaults[0], id: 'travel', title: 'Travel' }];
  assert.deepEqual(library.mergeLessons(defaults, imported, 'replace'), imported);
  assert.deepEqual(library.mergeLessons(defaults, imported, 'merge').map(item => item.id), ['intro', 'travel']);
  const exported = JSON.parse(library.exportLessons(defaults));
  assert.equal(exported.schemaVersion, 1);
  assert.deepEqual(exported.lessons, defaults);
});

test('maximum valid export always fits the documented import limit and round-trips', () => {
  delete require.cache[MODULE];
  const library = require(MODULE);
  const maximum = Array.from({ length: 100 }, (_, index) => ({
    id: `lesson-${index}`,
    title: 't'.repeat(120),
    level: 'l'.repeat(60),
    objectives: Array.from({ length: 10 }, () => 'o'.repeat(300)),
    opening_line: 'x'.repeat(1000),
  }));
  const exported = library.exportLessons(maximum);
  assert.ok(Buffer.byteLength(exported, 'utf8') <= library.MAX_IMPORT_BYTES);
  assert.deepEqual(library.parseLessonImport(exported), maximum);
});

test('escapes imported text before HTML rendering', () => {
  delete require.cache[MODULE];
  const library = require(MODULE);
  assert.equal(library.escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});
