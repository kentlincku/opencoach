'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const speech = require('../apps/desktop/speech-model-selection.cjs');

test('canonicalLanguageTag preserves the canonical full locale', () => {
  assert.equal(typeof speech.canonicalLanguageTag, 'function');
  for (const [input, expected] of [
    ['EN-us', 'en-US'], ['zh-hant-tw', 'zh-Hant-TW'], ['sr-latn-rs', 'sr-Latn-RS'],
    ['en-us-u-ca-gregory', 'en-US-u-ca-gregory'], ['en-gb-x-private', 'en-GB-x-private'],
    ['iw-IL', 'he-IL'], ['en', 'en'],
  ]) assert.equal(speech.canonicalLanguageTag(input), expected);
});

test('canonicalLanguageTag rejects invalid tags without coercion or repair', () => {
  let coerced = false;
  const object = { toString() { coerced = true; return 'en'; } };
  for (const input of [undefined, null, 42, true, ['en'], [], new String('en'), object,
    '', ' en', 'en ', 'en\n', 'en_US', 'en--US', 'en-abcdef-abcdef', '*']) {
    assert.throws(() => speech.canonicalLanguageTag(input),
      { name: 'TypeError', message: 'INVALID_LANGUAGE_TAG' });
  }
  assert.equal(coerced, false);
});

// Synthetic capability metadata only; not reviewed product-language support.
const stt = (overrides = {}) => ({
  id: 'whisper-en', kind: 'stt', backend: 'mlx-whisper', format: 'mlx',
  languages: ['en'], runtimeProfiles: ['darwin-arm64'], ...overrides,
});
const schemaError = { name: 'TypeError', message: 'INVALID_SPEECH_MODEL_CAPABILITIES' };

test('parseSpeechModelCapabilities projects canonical metadata in input order', () => {
  assert.equal(typeof speech.parseSpeechModelCapabilities, 'function');
  const input = [stt({ languages: ['EN-us', 'zh-hant-tw'] }), stt({ id: 'second' })];
  const result = speech.parseSpeechModelCapabilities(input);
  assert.deepEqual(result, [stt({ languages: ['en-US', 'zh-Hant-TW'] }), stt({ id: 'second' })]);
  assert.deepEqual(input[0].languages, ['EN-us', 'zh-hant-tw']);
  assert.deepEqual(speech.parseSpeechModelCapabilities([]), []);
});

test('capability records require exact own enumerable data fields', () => {
  const variants = [];
  for (const key of ['url', 'path', 'env', 'command', 'hash', 'sha256', 'uiLocale', 'enabledLanguages']) {
    variants.push(stt({ [key]: 'untrusted' }));
  }
  for (const key of Object.keys(stt())) {
    const missing = stt(); delete missing[key]; variants.push(missing);
  }
  variants.push(null, [], 'model', 1, new (class Model {})());
  variants.push(Object.assign(Object.create({ extra: true }), stt()));
  variants.push(Object.defineProperty(stt(), Symbol('field'), { value: 'hidden' }));
  variants.push(Object.defineProperty(stt(), 'hidden', { value: 'hidden' }));
  variants.push(Object.defineProperty(stt(), 'id', { enumerable: false }));
  let reads = 0;
  variants.push(Object.defineProperty(stt(), 'id', { enumerable: true, get() { reads++; return 'whisper-en'; } }));
  for (const input of variants) assert.throws(() => speech.parseSpeechModelCapabilities([input]), schemaError);
  assert.equal(reads, 0);
  assert.deepEqual(speech.parseSpeechModelCapabilities([Object.assign(Object.create(null), stt())]), [stt()]);
});

test('capability collections require dense undecorated ordinary arrays', () => {
  let reads = 0;
  for (const [item, wrap] of [[stt(), value => value],
    ['en', value => [stt({ languages: value })]],
    ['darwin-arm64', value => [stt({ runtimeProfiles: value })]]]) {
    for (const mutate of [
      value => { value.extra = true; },
      value => { Object.defineProperty(value, 'hidden', { value: true }); },
      value => { value[Symbol('extra')] = true; },
      value => { delete value[0]; },
      value => { Object.setPrototypeOf(value, Object.create(Array.prototype)); },
      value => { Object.defineProperty(value, '0', { enumerable: false }); },
      value => { Object.defineProperty(value, '0', { enumerable: true, get() { reads++; return 'en'; } }); },
    ]) {
      const value = [item];
      mutate(value);
      assert.throws(() => speech.parseSpeechModelCapabilities(wrap(value)), schemaError);
    }
  }
  for (const value of [null, {}, 'en', new Set(), new (class extends Array {})(),
    { map() { reads++; return []; } }]) {
    assert.throws(() => speech.parseSpeechModelCapabilities(value), schemaError);
  }
  assert.equal(reads, 0);
  assert.deepEqual(speech.parseSpeechModelCapabilities(Object.freeze([stt()])), [stt()]);
});

test('capability metadata accepts only explicit kinds and bounded opaque tokens', () => {
  for (const field of ['id', 'backend', 'format']) {
    for (const value of ['', '.', '..', '../model', 'https://host/model', 'UPPER', 'bad value',
      'valid\n', 'bad\0value', 'x'.repeat(129), null, 1, {}, ['en'], new String('token')]) {
      assert.throws(() => speech.parseSpeechModelCapabilities([stt({ [field]: value })]), schemaError);
    }
  }
  for (const kind of ['STT', 'voice', 'cloud', '', null, {}, ['stt']]) {
    assert.throws(() => speech.parseSpeechModelCapabilities([stt({ kind })]), schemaError);
  }
  for (const value of ['', '/runtime', 'valid\n', 'x'.repeat(129), null, {}, ['darwin-arm64']]) {
    assert.throws(() => speech.parseSpeechModelCapabilities([stt({ runtimeProfiles: [value] })]), schemaError);
  }
  const future = stt({ id: 'future-pack', backend: 'future-engine', format: 'future-format',
    runtimeProfiles: ['future-profile'] });
  assert.deepEqual(speech.parseSpeechModelCapabilities([future]), [future]);
});

test('capability language and runtime lists are nonempty and canonical-unique', () => {
  for (const languages of [[], ['en', 'EN'], ['iw-IL', 'he-IL'], ['en_US'], [null], [1], [' en'],
    'en', { 0: 'en', length: 1 }]) {
    assert.throws(() => speech.parseSpeechModelCapabilities([stt({ languages })]), schemaError);
  }
  for (const runtimeProfiles of [[], ['darwin-arm64', 'darwin-arm64'], 'darwin-arm64']) {
    assert.throws(() => speech.parseSpeechModelCapabilities([stt({ runtimeProfiles })]), schemaError);
  }
  const distinct = stt({ languages: ['en', 'en-US', 'en-GB', 'zh-TW', 'zh-Hant-TW'],
    runtimeProfiles: ['darwin-arm64', 'future-profile'] });
  assert.deepEqual(speech.parseSpeechModelCapabilities([distinct]), [distinct]);
});

test('model IDs are unique across kinds without case or whitespace repair', () => {
  for (const duplicate of [stt(), stt({ languages: ['zh-TW'] }), stt({ kind: 'tts' })]) {
    assert.throws(() => speech.parseSpeechModelCapabilities([stt(), duplicate]), schemaError);
  }
  const ids = [stt({ id: 'constructor' }), stt({ id: 'tostring' }), stt({ id: 'hasownproperty' })];
  assert.deepEqual(speech.parseSpeechModelCapabilities(ids), ids);
});

const tts = (overrides = {}) => ({
  id: 'kokoro-en', kind: 'tts', backend: 'kokoro-onnx', format: 'onnx',
  languages: ['en'], runtimeProfiles: ['darwin-arm64'], ...overrides,
});

test('TTS voice metadata keeps its own canonical language capabilities', () => {
  const model = tts({ languages: ['en-US', 'zh-Hant-TW'], voices: [
    { id: 'voice-en', languages: ['EN-us'] },
    { id: 'voice-tw', languages: ['zh-hant-tw'] },
  ] });
  let result;
  assert.doesNotThrow(() => { result = speech.parseSpeechModelCapabilities([model]); });
  assert.deepEqual(result, [tts({ languages: ['en-US', 'zh-Hant-TW'], voices: [
    { id: 'voice-en', languages: ['en-US'] },
    { id: 'voice-tw', languages: ['zh-Hant-TW'] },
  ] })]);
  assert.deepEqual(model.voices[0].languages, ['EN-us']);
  assert.deepEqual(speech.parseSpeechModelCapabilities([tts()]), [tts()]);
});

test('STT capabilities cannot carry TTS voices even when empty', () => {
  for (const voices of [[], [{ id: 'voice-en', languages: ['en'] }], undefined]) {
    assert.throws(() => speech.parseSpeechModelCapabilities([stt({ voices })]), schemaError);
  }
});

test('voice metadata uses the same exact-own-data schema boundary', () => {
  const voice = () => ({ id: 'voice-en', languages: ['en'] });
  const variants = ['url', 'path', 'backend', 'kind', 'format', 'env', 'command', 'sha256']
    .map(key => ({ ...voice(), [key]: 'untrusted' }));
  variants.push({}, { id: 'voice-en' }, { languages: ['en'] }, null, [],
    Object.assign(Object.create({ inherited: true }), voice()),
    Object.defineProperty(voice(), 'hidden', { value: true }),
    Object.defineProperty(voice(), Symbol('extra'), { value: true }),
    Object.defineProperty(voice(), 'languages', { enumerable: false }));
  let reads = 0;
  variants.push(Object.defineProperty(voice(), 'id', { enumerable: true, get() { reads++; return 'voice-en'; } }));
  for (const input of variants) assert.throws(() => speech.parseSpeechModelCapabilities([tts({ voices: [input] })]), schemaError);
  for (const id of ['', 'bad/id', 'valid\n', null, {}, ['voice-en']]) {
    assert.throws(() => speech.parseSpeechModelCapabilities([tts({ voices: [{ ...voice(), id }] })]), schemaError);
  }
  const decorated = [voice()]; decorated.extra = true;
  const sparse = Array(1);
  const accessor = [voice()];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return voice(); } });
  for (const voices of [decorated, sparse, accessor, null, undefined, {}, 'voice-en', new (class extends Array {})()]) {
    assert.throws(() => speech.parseSpeechModelCapabilities([tts({ voices })]), schemaError);
  }
  assert.equal(reads, 0);
});

test('present voice lists are nonempty with IDs unique inside each model', () => {
  for (const voices of [[], [{ id: 'same', languages: ['en'] }, { id: 'same', languages: ['en-US'] }]]) {
    assert.throws(() => speech.parseSpeechModelCapabilities([tts({ languages: ['en', 'en-US'], voices })]), schemaError);
  }
  const voices = [{ id: 'shared', languages: ['en'] }];
  const models = [tts({ voices }), tts({ id: 'another-tts', voices })];
  assert.deepEqual(speech.parseSpeechModelCapabilities(models), models);
});

test('voice languages cannot broaden model languages or use prefix fallback', () => {
  for (const languages of [['zh-TW'], ['en-US'], ['en', 'zh-TW'], [], ['en', 'EN'], ['en_US']]) {
    assert.throws(() => speech.parseSpeechModelCapabilities([tts({ voices: [{ id: 'voice', languages }] })]), schemaError);
  }
  const model = tts({ languages: ['en-US'], voices: [{ id: 'voice', languages: ['EN-us'] }] });
  assert.deepEqual(speech.parseSpeechModelCapabilities([model])[0].voices[0].languages, ['en-US']);
});

test('parsed capabilities are deeply frozen detached snapshots', () => {
  const input = [stt(), tts({ voices: [{ id: 'voice', languages: ['en'] }] })];
  const expected = structuredClone(input);
  const parsed = speech.parseSpeechModelCapabilities(input);
  const assertFrozenTree = value => {
    if (!value || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) assertFrozenTree(child);
  };
  assertFrozenTree(parsed);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input[0]), false);
  assert.equal(Object.isFrozen(input[1].voices[0].languages), false);
  for (const mutate of [() => parsed.push(stt({ id: 'extra' })),
    () => { parsed[0].id = 'changed'; }, () => parsed[0].languages.push('zh-TW'),
    () => parsed[0].runtimeProfiles.push('future-profile'), () => parsed[1].voices.pop(),
    () => { parsed[1].voices[0].id = 'changed'; }, () => parsed[1].voices[0].languages.push('zh-TW')]) {
    assert.throws(mutate, TypeError);
  }
  input[0].languages.push('zh-TW');
  input[0].runtimeProfiles[0] = 'future-profile';
  input[1].voices[0].id = 'changed';
  input[1].voices[0].languages.push('zh-TW');
  input.push(stt({ id: 'extra' }));
  assert.deepEqual(parsed, expected);
  assert.deepEqual(speech.parseSpeechModelCapabilities(parsed), expected);
  assertFrozenTree(speech.parseSpeechModelCapabilities([]));
});

test('data boundaries reject proxies without executing any proxy traps', () => {
  let traps = 0;
  const handler = {
    get() { traps++; throw new Error('must not execute'); },
    getPrototypeOf() { traps++; return Object.prototype; },
    ownKeys() { traps++; return []; },
    getOwnPropertyDescriptor() { traps++; return undefined; },
  };
  for (const [value, wrap] of [[stt(), value => [value]], [[stt()], value => value],
    [['en'], value => [stt({ languages: value })]],
    [['darwin-arm64'], value => [stt({ runtimeProfiles: value })]],
    [[{ id: 'voice', languages: ['en'] }], value => [tts({ voices: value })]],
    [{ id: 'voice', languages: ['en'] }, value => [tts({ voices: [value] })]]]) {
    for (const proxy of [new Proxy(value, {}), new Proxy(value, handler)]) {
      assert.throws(() => speech.parseSpeechModelCapabilities(wrap(proxy)), schemaError);
    }
    const revoked = Proxy.revocable(value, {}); revoked.revoke();
    assert.throws(() => speech.parseSpeechModelCapabilities(wrap(revoked.proxy)), schemaError);
  }
  assert.equal(traps, 0);
});

test('capability collections have explicit finite admission bounds', () => {
  const models = Array.from({ length: 257 }, (_, index) => stt({ id: `model-${index}` }));
  assert.throws(() => speech.parseSpeechModelCapabilities(models), schemaError);
  assert.equal(speech.parseSpeechModelCapabilities(models.slice(0, 256)).length, 256);
  const languages = Array.from({ length: 65 }, (_, index) => `en-x-l${index}`);
  assert.throws(() => speech.parseSpeechModelCapabilities([stt({ languages })]), schemaError);
  assert.equal(speech.parseSpeechModelCapabilities([stt({ languages: languages.slice(0, 64) })])[0].languages.length, 64);
  const runtimeProfiles = Array.from({ length: 33 }, (_, index) => `runtime-${index}`);
  assert.throws(() => speech.parseSpeechModelCapabilities([stt({ runtimeProfiles })]), schemaError);
  assert.equal(speech.parseSpeechModelCapabilities([stt({ runtimeProfiles: runtimeProfiles.slice(0, 32) })])[0].runtimeProfiles.length, 32);
  const voices = Array.from({ length: 257 }, (_, index) => ({ id: `voice-${index}`, languages: ['en'] }));
  assert.throws(() => speech.parseSpeechModelCapabilities([tts({ voices })]), schemaError);
  assert.equal(speech.parseSpeechModelCapabilities([tts({ voices: voices.slice(0, 256) })])[0].voices.length, 256);
});

const request = (overrides = {}) => ({
  kind: 'stt', targetLanguage: 'en', runtimeProfile: 'darwin-arm64', enabledLanguages: ['en'], ...overrides,
});
const unavailable = reason => ({ state: 'unavailable', reason });
const selectionError = { name: 'TypeError', message: 'INVALID_SPEECH_MODEL_SELECTION' };

test('selectSpeechModel returns only compatible model identity and canonical context', () => {
  assert.equal(typeof speech.selectSpeechModel, 'function');
  const capabilities = speech.parseSpeechModelCapabilities([stt()]);
  const options = request({ targetLanguage: 'EN', enabledLanguages: ['EN'] });
  assert.deepEqual(speech.selectSpeechModel(capabilities, options), {
    state: 'compatible', modelId: 'whisper-en', kind: 'stt', backend: 'mlx-whisper',
    format: 'mlx', targetLanguage: 'en', runtimeProfile: 'darwin-arm64',
  });
  assert.equal(options.targetLanguage, 'EN');
  assert.deepEqual(options.enabledLanguages, ['EN']);
});

test('selection requires explicit targetLanguage and rejects uiLocale as input', () => {
  const variants = [request({ uiLocale: 'zh-TW' }), request({ language: 'en' }),
    request({ force: true }), request({ path: '/model' }), request({ env: {} }), null, [], {},
    Object.assign(Object.create({ inherited: true }), request()),
    Object.defineProperty(request(), 'hidden', { value: true }),
    Object.defineProperty(request(), Symbol('extra'), { value: true }),
    Object.defineProperty(request(), 'targetLanguage', { enumerable: false })];
  const onlyUiLocale = request({ uiLocale: 'en' }); delete onlyUiLocale.targetLanguage;
  variants.push(onlyUiLocale);
  for (const key of Object.keys(request())) {
    const missing = request(); delete missing[key]; variants.push(missing);
  }
  let reads = 0;
  variants.push(Object.defineProperty(request(), 'targetLanguage', {
    enumerable: true, get() { reads++; return 'en'; },
  }));
  variants.push(new Proxy(request(), {}), new Proxy(request(), {
    getPrototypeOf() { reads++; return Object.prototype; },
    get() { reads++; return 'en'; },
  }));
  for (const options of variants) assert.throws(() => speech.selectSpeechModel([stt()], options), selectionError);
  assert.equal(reads, 0);
  const plain = Object.assign(Object.create(null), request({ modelId: 'whisper-en' }));
  assert.equal(speech.selectSpeechModel([stt()], plain).state, 'compatible');
});

test('selection validates values and enabled-language arrays before choosing', () => {
  for (const targetLanguage of [undefined, null, '', 'en_US', 'en\n', ['en'], new String('en'), {}]) {
    assert.throws(() => speech.selectSpeechModel([stt()], request({ targetLanguage })), selectionError);
  }
  for (const field of ['runtimeProfile', 'modelId']) {
    for (const value of [undefined, null, '', '../model', 'UPPER', 'valid\n', 'x'.repeat(129), {}, ['model']]) {
      assert.throws(() => speech.selectSpeechModel([stt()], request({ [field]: value })), selectionError);
    }
  }
  for (const kind of [null, '', 'voice', 'STT', {}, ['stt']]) {
    assert.throws(() => speech.selectSpeechModel([stt()], request({ kind })), selectionError);
  }
  let reads = 0;
  const accessor = ['en']; Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return 'en'; } });
  const decorated = ['en']; decorated.extra = true;
  const symbolic = ['en']; symbolic[Symbol('extra')] = true;
  const inherited = ['en']; Object.setPrototypeOf(inherited, Object.create(Array.prototype));
  for (const enabledLanguages of [undefined, null, 'en', {}, ['en', 'EN'], ['iw-IL', 'he-IL'], ['en_US'], [null],
    Array(1), decorated, symbolic, inherited, accessor, new Proxy(['en'], {}),
    Array.from({ length: 65 }, (_, index) => `en-x-l${index}`)]) {
    assert.throws(() => speech.selectSpeechModel([stt()], request({ enabledLanguages })), selectionError);
  }
  assert.equal(reads, 0);
  assert.doesNotThrow(() => speech.selectSpeechModel([stt()], request({ enabledLanguages: [] })));
});

test('reviewed enabledLanguages gates even upstream multilingual models', () => {
  const multilingual = stt({ languages: ['en', 'en-US', 'en-GB', 'zh-TW'] });
  for (const targetLanguage of ['zh-TW', 'en-US', 'en-GB']) {
    for (const extra of [{}, { modelId: 'whisper-en' }]) {
      assert.deepEqual(speech.selectSpeechModel([multilingual], request({ targetLanguage, ...extra })),
        unavailable('LANGUAGE_NOT_SUPPORTED'));
    }
  }
  assert.deepEqual(speech.selectSpeechModel([multilingual], request({ enabledLanguages: [] })),
    unavailable('LANGUAGE_NOT_SUPPORTED'));
  assert.deepEqual(speech.selectSpeechModel([multilingual], request({ enabledLanguages: ['en-US'] })),
    unavailable('LANGUAGE_NOT_SUPPORTED'));
  assert.equal(speech.selectSpeechModel([multilingual], request()).modelId, 'whisper-en');
});

test('selection intersects exact canonical locales without English or prefix fallback', () => {
  for (const [languages, targetLanguage] of [
    [['en'], 'zh-TW'], [['en'], 'en-US'], [['en-US'], 'en'], [['en-US'], 'en-GB'],
    [['zh-Hant-TW'], 'zh-TW'], [['en'], 'en-US-u-ca-gregory'],
  ]) {
    assert.deepEqual(speech.selectSpeechModel([stt({ languages })], request({
      targetLanguage, enabledLanguages: [targetLanguage],
    })), unavailable('LANGUAGE_NOT_SUPPORTED'));
  }
  assert.deepEqual(speech.selectSpeechModel([], request()), unavailable('LANGUAGE_NOT_SUPPORTED'));
  // Future-only fixture: one pack ID can cover multiple independently reviewed full locales.
  const shared = stt({ id: 'shared-pack', languages: ['en', 'en-US', 'zh-Hant-TW'] });
  for (const targetLanguage of ['en', 'EN-us', 'zh-hant-tw']) {
    const result = speech.selectSpeechModel([shared], request({ targetLanguage, enabledLanguages: [targetLanguage] }));
    assert.equal(result.modelId, 'shared-pack');
    assert.equal(result.targetLanguage, speech.canonicalLanguageTag(targetLanguage));
  }
  assert.equal(speech.selectSpeechModel([stt(), shared], request({
    targetLanguage: 'zh-Hant-TW', enabledLanguages: ['zh-Hant-TW'],
  })).modelId, 'shared-pack');
});

test('selection requires the requested speech kind and declared runtime profile', () => {
  for (const model of [tts(), stt({ runtimeProfiles: ['win32-x64-cpu'] }),
    stt({ runtimeProfiles: ['darwin-arm64-extra'] })]) {
    assert.deepEqual(speech.selectSpeechModel([model], request()), unavailable('MODEL_NOT_COMPATIBLE'));
  }
  assert.deepEqual(speech.selectSpeechModel([stt()], request({ kind: 'tts' })), unavailable('MODEL_NOT_COMPATIBLE'));
  assert.equal(speech.selectSpeechModel([tts(), stt()], request()).modelId, 'whisper-en');
  assert.equal(speech.selectSpeechModel([stt(), tts()], request({ kind: 'tts' })).modelId, 'kokoro-en');
  const wrongRuntime = stt({ id: 'wrong-runtime', runtimeProfiles: ['future-profile'] });
  assert.equal(speech.selectSpeechModel([wrongRuntime, stt()], request()).modelId, 'whisper-en');
});

test('runtime compatibility requires a reviewed backend and format tuple', () => {
  for (const model of [stt({ format: 'onnx' }), stt({ format: 'gguf' }),
    stt({ backend: 'faster-whisper', format: 'ctranslate2' }), stt({ backend: 'cloud' }),
    stt({ backend: 'constructor' }), tts({ backend: 'mlx-whisper' }), tts({ format: 'mlx' })]) {
    assert.deepEqual(speech.selectSpeechModel([model], request({ kind: model.kind })), unavailable('MODEL_NOT_COMPATIBLE'));
  }
  for (const runtimeProfile of ['linux-x64', 'future-profile', 'constructor']) {
    assert.deepEqual(speech.selectSpeechModel([stt({ runtimeProfiles: [runtimeProfile] })], request({ runtimeProfile })),
      unavailable('MODEL_NOT_COMPATIBLE'));
  }
  for (const runtimeProfile of ['darwin-arm64', 'win32-x64-cpu', 'win32-x64-cuda']) {
    const isMac = runtimeProfile === 'darwin-arm64';
    const model = stt({ backend: isMac ? 'mlx-whisper' : 'faster-whisper',
      format: isMac ? 'mlx' : 'ctranslate2', runtimeProfiles: [runtimeProfile] });
    assert.equal(speech.selectSpeechModel([model], request({ runtimeProfile })).state, 'compatible');
    assert.equal(speech.selectSpeechModel([tts({ runtimeProfiles: [runtimeProfile] })],
      request({ kind: 'tts', runtimeProfile })).state, 'compatible');
    const foreign = stt({ backend: isMac ? 'faster-whisper' : 'mlx-whisper',
      format: isMac ? 'ctranslate2' : 'mlx', runtimeProfiles: [runtimeProfile] });
    assert.deepEqual(speech.selectSpeechModel([foreign], request({ runtimeProfile })), unavailable('MODEL_NOT_COMPATIBLE'));
  }
  assert.equal(speech.selectSpeechModel([stt({ id: 'bad-format', format: 'onnx' }), stt()], request()).modelId, 'whisper-en');
});

test('an explicit model ID is exact and never silently replaced', () => {
  for (const capabilities of [[], [stt()]]) {
    for (const modelId of ['missing', 'constructor', 'whisper-en-other']) {
      assert.deepEqual(speech.selectSpeechModel(capabilities, request({ modelId })), unavailable('UNKNOWN_MODEL'));
    }
  }
  const second = stt({ id: 'second' });
  for (const capabilities of [[stt(), second], [second, stt()]]) {
    assert.equal(speech.selectSpeechModel(capabilities, request({ modelId: 'second' })).modelId, 'second');
  }
  assert.equal(speech.selectSpeechModel([stt({ id: 'constructor' })], request({ modelId: 'constructor' })).modelId, 'constructor');
});

test('explicit model IDs cannot bypass any capability constraint or use another pack', () => {
  for (const overrides of [{ languages: ['zh-TW'] }, { kind: 'tts', backend: 'kokoro-onnx', format: 'onnx' },
    { runtimeProfiles: ['win32-x64-cpu'] }, { format: 'onnx' }, { backend: 'cloud' }]) {
    const incompatible = stt({ id: 'requested', ...overrides });
    for (const models of [[stt(), incompatible], [incompatible, stt()]]) {
      assert.deepEqual(speech.selectSpeechModel(models, request({ modelId: 'requested' })),
        unavailable('MODEL_NOT_COMPATIBLE'));
    }
  }
  assert.deepEqual(speech.selectSpeechModel([stt()], request({
    modelId: 'whisper-en', targetLanguage: 'zh-TW', enabledLanguages: ['zh-TW'],
  })), unavailable('MODEL_NOT_COMPATIBLE'));
  assert.deepEqual(speech.selectSpeechModel([stt()], request({ modelId: 'missing', enabledLanguages: [] })),
    unavailable('LANGUAGE_NOT_SUPPORTED'));
});

test('multiple compatible packs require an explicit model ID rather than an order guess', () => {
  const first = stt();
  const second = stt({ id: 'second' });
  for (const models of [[first, second], [second, first]]) {
    assert.deepEqual(speech.selectSpeechModel(models, request()), unavailable('AMBIGUOUS_MODEL'));
    assert.equal(speech.selectSpeechModel(models, request({ modelId: 'second' })).modelId, 'second');
  }
  const ineligible = [tts(), stt({ id: 'different-locale', languages: ['en-US'] }),
    stt({ id: 'different-runtime', runtimeProfiles: ['win32-x64-cpu'] }),
    stt({ id: 'different-format', format: 'onnx' })];
  assert.equal(speech.selectSpeechModel([...ineligible, first], request()).modelId, 'whisper-en');
});

test('a TTS pack with voice metadata needs a voice for the exact target locale', () => {
  const englishVoiceOnly = tts({ languages: ['en', 'en-US', 'zh-TW'],
    voices: [{ id: 'voice-en', languages: ['en'] }] });
  for (const targetLanguage of ['en-US', 'zh-TW']) {
    for (const extra of [{}, { modelId: 'kokoro-en' }]) {
      assert.deepEqual(speech.selectSpeechModel([englishVoiceOnly], request({
        kind: 'tts', targetLanguage, enabledLanguages: [targetLanguage], ...extra,
      })), unavailable('MODEL_NOT_COMPATIBLE'));
    }
  }
  assert.equal(speech.selectSpeechModel([englishVoiceOnly], request({ kind: 'tts' })).state, 'compatible');
  const matchingVoice = tts({ id: 'tts-target', languages: ['en-US'], voices: [{ id: 'voice-us', languages: ['en-US'] }] });
  assert.equal(speech.selectSpeechModel([englishVoiceOnly, matchingVoice], request({
    kind: 'tts', targetLanguage: 'en-US', enabledLanguages: ['en-US'],
  })).modelId, 'tts-target');
});

test('TTS results list only compatible voice IDs without choosing a voice', () => {
  const model = tts({ languages: ['en', 'zh-TW'], voices: [
    { id: 'voice-en', languages: ['en'] },
    { id: 'voice-shared', languages: ['en', 'zh-TW'] },
    { id: 'voice-tw', languages: ['zh-TW'] },
  ] });
  const result = speech.selectSpeechModel([model], request({ kind: 'tts', targetLanguage: 'zh-TW', enabledLanguages: ['zh-TW'] }));
  assert.deepEqual(result, {
    state: 'compatible', modelId: 'kokoro-en', kind: 'tts', backend: 'kokoro-onnx', format: 'onnx',
    targetLanguage: 'zh-TW', runtimeProfile: 'darwin-arm64', voiceIds: ['voice-shared', 'voice-tw'],
  });
  assert.deepEqual(speech.selectSpeechModel([model], request({ kind: 'tts' })).voiceIds, ['voice-en', 'voice-shared']);
  for (const [model, kind] of [[stt(), 'stt'], [tts(), 'tts']]) {
    const selected = speech.selectSpeechModel([model], request({ kind }));
    assert.equal(Object.hasOwn(selected, 'voiceIds'), false);
    assert.equal(Object.hasOwn(selected, 'voices'), false);
  }
});

test('selection results are immutable snapshots for every outcome', () => {
  const cases = [
    [[stt()], request()],
    [[tts({ voices: [{ id: 'voice', languages: ['en'] }] })], request({ kind: 'tts' })],
    [[stt()], request({ enabledLanguages: [] })],
    [[], request({ modelId: 'missing' })],
    [[stt({ format: 'onnx' })], request()],
    [[stt(), stt({ id: 'second' })], request()],
  ];
  for (const [models, options] of cases) {
    const before = structuredClone({ models, options });
    const result = speech.selectSpeechModel(models, options);
    assert.equal(Object.isFrozen(result), true);
    assert.throws(() => { result.state = 'modified'; }, TypeError);
    if (Object.hasOwn(result, 'voiceIds')) {
      assert.equal(Object.isFrozen(result.voiceIds), true);
      assert.throws(() => result.voiceIds.push('injected'), TypeError);
    }
    assert.deepEqual({ models, options }, before);
    assert.deepEqual(speech.selectSpeechModel(models, options), result);
  }
  const input = [stt()];
  const selected = speech.selectSpeechModel(input, request());
  input[0].languages = ['zh-TW'];
  assert.equal(selected.targetLanguage, 'en');
  assert.deepEqual(speech.selectSpeechModel(input, request()), unavailable('LANGUAGE_NOT_SUPPORTED'));
  input[0].url = 'https://untrusted.invalid/model';
  assert.throws(() => speech.selectSpeechModel(input, request()), schemaError);
  assert.throws(() => speech.selectSpeechModel([stt(), stt()], request({ enabledLanguages: [] })), schemaError);
});

test('selection never reads inherited optional voice capabilities', () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'voices');
  let reads = 0;
  Object.defineProperty(Object.prototype, 'voices', {
    configurable: true,
    get() { reads++; throw new Error('inherited optional data must not be read'); },
  });
  try {
    for (const [model, kind] of [[stt(), 'stt'], [tts(), 'tts']]) {
      let result;
      assert.doesNotThrow(() => { result = speech.selectSpeechModel([model], request({ kind })); });
      assert.equal(result.state, 'compatible');
      assert.equal(Object.hasOwn(result, 'voiceIds'), false);
    }
    assert.equal(reads, 0);
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'voices', original);
    else delete Object.prototype.voices;
  }
});
