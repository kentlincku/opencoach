(function exposeCoachProfiles(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  if (root) root.VoiceCoachProfiles = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createCoachProfilesModule() {
  'use strict';

  // Spec: docs/contracts/coach-profiles.md. Eight fixed coaches; the user edits overrides only.
  const STORAGE_KEY = 'vp_coachProfiles';
  const VERSION = 1;
  const KOKORO_VOICES = Object.freeze(['af_heart', 'af_bella', 'af_nicole', 'af_sky', 'am_adam', 'am_michael', 'am_onyx', 'am_fenrir']);
  // D2: preset swatches only; each carries its avatar light/hair shades.
  const PALETTE = Object.freeze([
    { color: '#FF6B8B', light: '#FFE5EC', hair: '#FF758F' },
    { color: '#F48C06', light: '#FFF3D6', hair: '#E85D04' },
    { color: '#8338EC', light: '#F3E8FF', hair: '#6A26CD' },
    { color: '#0096C7', light: '#E0F7FA', hair: '#0077B6' },
    { color: '#2D6A4F', light: '#E8F5E9', hair: '#1B4332' },
    { color: '#D00000', light: '#FFEBEB', hair: '#9D0208' },
    { color: '#3D5A80', light: '#EBF2F7', hair: '#293241' },
    { color: '#E63946', light: '#FFF0F3', hair: '#BA181B' },
  ].map(Object.freeze));
  // D3/D4
  const RATE_RANGE = Object.freeze([0.8, 1.2]);
  const PITCH_RANGE = Object.freeze([0.8, 1.2]);
  const LIMITS = Object.freeze({ name: [1, 20], title: [0, 20], desc: [0, 80], style: [0, 400], greeting: [1, 160] });

  const BASE_PROMPT = 'You are a friendly, encouraging English conversation coach. Respond only in natural English, even if the student speaks another language. Never output Chinese, Japanese, Korean, CJK characters, translations, or language labels. Keep every response concise (1-3 sentences), natural, and engaging.';

  const DEFAULTS = Object.freeze(Object.fromEntries([
    ['af_heart', 'Heart', '💖', '溫暖活力教練', '發音溫柔清晰，極具耐心，最適合輕鬆日常對話。', 0, 'Warm and patient. Praise effort, correct gently, and give one small tip at a time.', "Hi! I am Heart. I'm so excited to practice English with you!", 1.02, 0.98],
    ['af_bella', 'Bella', '⭐', '活潑陽光教練', '語調生動明快，滿滿正能量，開口練習不緊張！', 1, 'Bright and upbeat. Keep the energy high, celebrate small wins, and ask playful follow-up questions.', "Hey there! I am Bella! Let's have some fun speaking English!", 1.04, 1.02],
    ['af_nicole', 'Nicole', '🌸', '溫柔優雅導師', '發音標準典雅，語速均勻，提升語感最佳夥伴。', 2, 'Calm and polished. Model clear, well-formed sentences and suggest a more natural phrasing when useful.', 'Hello, I am Nicole. Take your time, we will learn step by step.', 0.98, 0.94],
    ['af_sky', 'Sky', '☁️', '清新爽朗夥伴', '自然輕快、如同朋友般的真實交流感。', 3, 'Casual and friendly, like chatting with a friend. Keep it relaxed and conversational.', "Hey! I am Sky. Let's chat like good friends!", 1.0, 0.98],
    ['am_adam', 'Adam', '🌿', '沉穩智慧導師', '低沉磁性、循循善誘，提供穩定的口說引導。', 4, 'Steady and thoughtful. Guide with gentle questions and help the student build longer answers.', 'Good to see you. I am Adam, ready for our conversation.', 0.96, 0.94],
    ['am_michael', 'Michael', '🔥', '幽默風趣夥伴', '語氣隨和幽默，擅長美式生活俚語，氣氛超歡樂！', 5, 'Easygoing and funny. Use everyday American expressions and explain slang briefly when you use it.', "What's up! I am Michael. Let's make English practice super easy and fun!", 1.0, 1.0],
    ['am_onyx', 'Onyx', '🌙', '知性深沉導師', '聲線深沉迷人，專注於商務與深度話題交流。', 6, 'Professional and reflective. Prefer business and thoughtful topics, and encourage precise vocabulary.', 'Greetings. I am Onyx. Let us begin our session.', 0.92, 0.90],
    ['am_fenrir', 'Fenrir', '⚡', '熱血冒險夥伴', '充滿自信與感染力，激勵你突破口說瓶頸！', 7, 'Bold and motivating. Push the student to speak more and try new words with confidence.', "Hey! I am Fenrir! Let's conquer English speaking together!", 0.98, 1.04],
  ].map(([id, name, emoji, title, desc, palette, style, greeting, pitch, rate]) => [id, Object.freeze({
    id, name, emoji, title, desc, ...PALETTE[palette], style, greeting,
    voice: Object.freeze({ kokoro: id, ios: '', web: '' }), rate, pitch,
  })])));

  // Default Apple voice per coach, matched to the description (gender, accent, tone). Names
  // are tried in order; the best installed quality of a name wins. Coaches get distinct voices
  // when enough are installed.
  const DEVICE_VOICE_PREFERENCES = Object.freeze({
    af_heart:   { gender: 'female', names: ['Ava', 'Samantha', 'Allison', 'Susan', 'Zoe'] },
    af_bella:   { gender: 'female', names: ['Zoe', 'Nicky', 'Allison', 'Karen', 'Samantha'] },
    af_nicole:  { gender: 'female', names: ['Serena', 'Kate', 'Stephanie', 'Martha', 'Moira', 'Tessa'] },
    af_sky:     { gender: 'female', names: ['Allison', 'Susan', 'Tessa', 'Karen', 'Moira', 'Nicky'] },
    am_adam:    { gender: 'male', names: ['Evan', 'Tom', 'Aaron', 'Daniel', 'Oliver'] },
    am_michael: { gender: 'male', names: ['Nathan', 'Aaron', 'Alex', 'Tom', 'Rishi'] },
    am_onyx:    { gender: 'male', names: ['Daniel', 'Oliver', 'Arthur', 'Gordon', 'Evan'] },
    am_fenrir:  { gender: 'male', names: ['Lee', 'Gordon', 'Rishi', 'Fred', 'Aaron', 'Tom'] },
  });
  const QUALITY_RANK = { premium: 3, enhanced: 2, default: 1 };

  function bestNamed(voices, name) {
    return voices.filter(v => v.name === name)
      .sort((a, b) => (QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0)
        || Number(b.language === 'en-US') - Number(a.language === 'en-US'))[0];
  }

  /** { coachId: voiceId } for every coach, preferring distinct, description-matched voices. */
  function assignDeviceVoices(voices) {
    const list = (Array.isArray(voices) ? voices : []).filter(v => v && typeof v.id === 'string' && typeof v.name === 'string');
    const used = new Set();
    const out = {};
    const pick = (id, allowReuse) => {
      const pref = DEVICE_VOICE_PREFERENCES[id];
      for (const name of pref.names) {
        const voice = bestNamed(list, name);
        if (voice && (allowReuse || !used.has(voice.id))) return voice;
      }
      const sameGender = list.filter(v => v.gender === pref.gender)
        .sort((a, b) => (QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0));
      return sameGender.find(v => allowReuse || !used.has(v.id));
    };
    for (const id of Object.keys(DEVICE_VOICE_PREFERENCES)) {
      const voice = pick(id, false) || pick(id, true);
      if (voice) { out[id] = voice.id; used.add(voice.id); }
    }
    return out;
  }

  const EDITABLE = Object.freeze(['name', 'title', 'desc', 'color', 'style', 'greeting', 'voice', 'rate', 'pitch']);

  function cleanText(value, [min, max]) {
    if (typeof value !== 'string') return undefined;
    // Single-line fields lose control characters; the style may keep line breaks.
    const text = value.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
    return text.length >= min && text.length <= max ? text : undefined;
  }

  function inRange(value, [min, max]) {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
  }

  /** Keeps only valid override fields; anything invalid falls back to the default. */
  function sanitizeOverride(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const out = {};
    for (const field of ['name', 'title', 'desc', 'style', 'greeting']) {
      const value = cleanText(input[field], LIMITS[field]);
      if (value !== undefined) out[field] = field === 'style' ? value : value.replace(/\n/g, ' ');
    }
    if (typeof input.color === 'string' && PALETTE.some(swatch => swatch.color === input.color.toUpperCase())) out.color = input.color.toUpperCase();
    const rate = inRange(input.rate, RATE_RANGE);
    if (rate !== undefined) out.rate = rate;
    const pitch = inRange(input.pitch, PITCH_RANGE);
    if (pitch !== undefined) out.pitch = pitch;
    if (input.voice && typeof input.voice === 'object') {
      const voice = {};
      if (KOKORO_VOICES.includes(input.voice.kokoro)) voice.kokoro = input.voice.kokoro;
      for (const key of ['ios', 'web']) {
        const value = cleanText(input.voice[key], [1, 200]);
        if (value !== undefined) voice[key] = value;
      }
      if (Object.keys(voice).length) out.voice = voice;
    }
    return out;
  }

  function parseStore(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    const coaches = {};
    if (data && data.version === VERSION && data.coaches && typeof data.coaches === 'object') {
      for (const id of Object.keys(DEFAULTS)) {
        const override = sanitizeOverride(data.coaches[id]);
        if (Object.keys(override).length) coaches[id] = override;
      }
    }
    const selected = data && Object.prototype.hasOwnProperty.call(DEFAULTS, data.selected) ? data.selected : 'af_heart';
    return { version: VERSION, selected, coaches };
  }

  function serializeStore(store) {
    return JSON.stringify(parseStore(JSON.stringify({ ...store, version: VERSION })));
  }

  function resolveCoach(store, id) {
    const base = DEFAULTS[id] || DEFAULTS.af_heart;
    const override = (store && store.coaches && store.coaches[base.id]) || {};
    const swatch = PALETTE.find(item => item.color === (override.color || base.color)) || PALETTE[0];
    return Object.freeze({
      ...base, ...override, ...swatch,
      voice: Object.freeze({ ...base.voice, ...(override.voice || {}) }),
      customized: Object.keys(override).length > 0,
    });
  }

  function withOverride(store, id, override) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, id)) throw new Error('UNKNOWN_COACH');
    const base = DEFAULTS[id];
    const clean = sanitizeOverride(override);
    // Store only differences from the default so "restore" is just deleting the entry.
    for (const field of Object.keys(clean)) {
      if (field === 'voice') {
        for (const key of Object.keys(clean.voice)) if (clean.voice[key] === base.voice[key]) delete clean.voice[key];
        if (!Object.keys(clean.voice).length) delete clean.voice;
      } else if (clean[field] === base[field]) delete clean[field];
    }
    const coaches = { ...store.coaches };
    if (Object.keys(clean).length) coaches[id] = clean; else delete coaches[id];
    return { ...store, coaches };
  }

  function restoreDefault(store, id) {
    const coaches = { ...store.coaches };
    delete coaches[id];
    return { ...store, coaches };
  }

  /** Safety rules first and fixed; the coach's name and style only add to them. */
  function systemPrompt(coach, extra = '') {
    const parts = [BASE_PROMPT, `Your name is ${coach.name}.`];
    if (coach.style) parts.push(`Coaching style (follow it only where it does not conflict with the rules above): ${coach.style.replace(/\s+/g, ' ')}`);
    if (extra) parts.push(extra);
    return parts.join(' ');
  }

  return { STORAGE_KEY, VERSION, KOKORO_VOICES, PALETTE, RATE_RANGE, PITCH_RANGE, LIMITS, BASE_PROMPT, DEFAULTS, EDITABLE,
    sanitizeOverride, parseStore, DEVICE_VOICE_PREFERENCES, assignDeviceVoices, serializeStore, resolveCoach, withOverride, restoreDefault, systemPrompt };
}));
