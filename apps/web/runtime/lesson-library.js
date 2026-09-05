(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VoiceLessonLibrary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'vp_lessons_v1';
  const SCHEMA_VERSION = 1;
  const MAX_LESSONS = 100;
  const MAX_IMPORT_BYTES = 1024 * 1024;

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeLessons(input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_LESSONS) {
      throw new Error('LESSONS_REQUIRED');
    }
    const ids = new Set();
    return input.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('INVALID_LESSON');
      const id = text(item.id);
      const title = text(item.title);
      const level = text(item.level);
      const opening = text(item.opening_line);
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) throw new Error('INVALID_LESSON_ID');
      if (ids.has(id)) throw new Error('DUPLICATE_LESSON_ID');
      ids.add(id);
      if (!title || title.length > 120) throw new Error('INVALID_LESSON_TITLE');
      if (!level || level.length > 60) throw new Error('INVALID_LESSON_LEVEL');
      if (!opening || opening.length > 1000) throw new Error('INVALID_OPENING_LINE');
      if (!Array.isArray(item.objectives) || item.objectives.length < 1 || item.objectives.length > 10) {
        throw new Error('INVALID_OBJECTIVES');
      }
      const objectives = item.objectives.map(value => {
        const objective = text(value);
        if (!objective || objective.length > 300) throw new Error('INVALID_OBJECTIVE');
        return objective;
      });
      return { id, title, level, objectives, opening_line: opening };
    });
  }

  function saveLessons(storage, lessons) {
    const normalized = normalizeLessons(lessons);
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function loadLessons(storage, defaults) {
    const fallback = normalizeLessons(defaults);
    const stored = storage.getItem(STORAGE_KEY);
    if (stored !== null) {
      try {
        return normalizeLessons(JSON.parse(stored));
      } catch (_) {
        // Replace corrupt local data with the safe built-in starter library.
      }
    }
    return saveLessons(storage, fallback);
  }

  function parseLessonImport(source) {
    let payload;
    try {
      payload = typeof source === 'string' ? JSON.parse(source) : source;
    } catch (_) {
      throw new Error('INVALID_JSON');
    }
    if (Array.isArray(payload)) return normalizeLessons(payload);
    if (!payload || typeof payload !== 'object' || payload.schemaVersion !== SCHEMA_VERSION) {
      throw new Error('UNSUPPORTED_SCHEMA');
    }
    return normalizeLessons(payload.lessons);
  }

  function mergeLessons(current, imported, mode) {
    const incoming = normalizeLessons(imported);
    if (mode === 'replace') return incoming;
    if (mode !== 'merge') throw new Error('INVALID_IMPORT_MODE');
    const result = normalizeLessons(current);
    const positions = new Map(result.map((item, index) => [item.id, index]));
    for (const item of incoming) {
      if (positions.has(item.id)) result[positions.get(item.id)] = item;
      else {
        positions.set(item.id, result.length);
        result.push(item);
      }
    }
    return normalizeLessons(result);
  }

  function exportLessons(lessons) {
    return JSON.stringify({ schemaVersion: SCHEMA_VERSION, lessons: normalizeLessons(lessons) }, null, 2) + '\n';
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  return {
    STORAGE_KEY,
    SCHEMA_VERSION,
    MAX_IMPORT_BYTES,
    normalizeLessons,
    saveLessons,
    loadLessons,
    parseLessonImport,
    mergeLessons,
    exportLessons,
    escapeHtml,
  };
});
