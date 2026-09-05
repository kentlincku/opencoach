(function exposeLanguagePolicy(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  if (root) root.VoiceLanguagePolicy = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createLanguagePolicy() {
  'use strict';

  const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\u31F0-\u31FF\uAC00-\uD7AF]/u;
  const CJK_GLOBAL_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\u31F0-\u31FF\uAC00-\uD7AF]+/gu;
  const REPAIR_INSTRUCTION = 'Rewrite your previous reply in natural English only. Use 1-3 concise sentences. Do not include Chinese, Japanese, Korean, translations, labels, or explanations.';
  const SAFE_ENGLISH_FALLBACK = "Let's continue in English. Could you say that again in English?";

  function containsCjk(text) {
    return CJK_PATTERN.test(String(text || ''));
  }

  function isEnglishOnlyReply(text) {
    const value = String(text || '').trim();
    return Boolean(value) && !containsCjk(value);
  }

  function sanitizeEnglishSpeechText(text) {
    let cleaned = String(text || '')
      .replace(/[，、]/g, ',')
      .replace(/。/g, '.')
      .replace(/！/g, '!')
      .replace(/？/g, '?')
      .replace(CJK_GLOBAL_PATTERN, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/,\s*/g, ', ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[A-Za-z0-9]/.test(cleaned)) return '';
    return cleaned;
  }

  return Object.freeze({
    REPAIR_INSTRUCTION,
    SAFE_ENGLISH_FALLBACK,
    containsCjk,
    isEnglishOnlyReply,
    sanitizeEnglishSpeechText,
  });
}));
