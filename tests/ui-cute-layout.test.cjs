'use strict';
// Layout contract for the "cute single-column" redesign.
// Static + vm checks only; the real
// rendering is verified with screenshots, not here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'apps/web/index.html'), 'utf8');
const MODEL_JS = fs.readFileSync(path.join(ROOT, 'apps/web/native-model-settings.js'), 'utf8');
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('<script src='));

// Outer source of the element carrying `id`, matched by balancing same-name tags.
function elementSource(id) {
  const open = BODY.search(new RegExp(`<([a-z]+)[^>]*\\bid="${id}"`));
  assert.ok(open >= 0, `missing #${id}`);
  const tag = BODY.slice(open + 1).match(/^[a-z]+/)[0];
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = open;
  let depth = 0;
  for (let m; (m = re.exec(BODY));) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return BODY.slice(open, re.lastIndex);
  }
  throw new Error(`unbalanced #${id}`);
}
function fn(name) {
  const found = HTML.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(found, `missing function ${name}`);
  return found[0];
}

const PRESERVED_IDS = `activeLanHttpWarning apiBaseUrl apiBaseUrlGroup apiKey apiKeyGroup apiKeyHint apiModel avatarStage
  btnIcon btnText chatBox coachCard coachDesc coachGrid coachHeaderTag coachModal coachTitle currentLessonTitle directApiPreset
  directApiPresetGroup headerConnBadge headerConnDot headerConnText kokoroDebugLog kokoroTtsOption lessonCount lessonImportFile
  lessonImportMode lessonJsonEditor lessonListContainer lessonManagerModal lessonManagerResult lessonPracticeBanner
  localEndpointNotice micNotice migrationNotice modelDetectNotice modelSelect msgAvatarIcon nativeModelSettings offlineStatus
  providerSelect sectionFreeChat sectionLesson settingsModal shadowResultBox startBtn statusLabel statusPill
  subscriptionCodeInput subscriptionCodeRow subscriptionGroup subscriptionLoginBtn subscriptionLogoutBtn subscriptionStatusText
  tabBtnFree tabBtnLesson testConnResult toggleManualModelBtn ttsEngineLabel ttsModeHint ttsModeSelect userTextInput`.split(/\s+/);

test('every pre-redesign element id is still present exactly once', () => {
  for (const id of PRESERVED_IDS) {
    const count = BODY.split(`id="${id}"`).length - 1;
    assert.equal(count, 1, `#${id} must exist exactly once (found ${count})`);
  }
  for (const name of ['switchTab', 'openSettingsModal', 'closeSettingsModal', 'openCoachModal', 'closeCoachModal',
    'selectCoach', 'returnToLessonList', 'completeCurrentLesson', 'toggleConversation', 'stopConversation',
    'sendManualText', 'startShadowing', 'saveSettings', 'testApiConnection', 'openLessonManager', 'renderAvatarSVG']) {
    assert.match(HTML, new RegExp(`function ${name}\\(`), `global ${name} kept`);
  }
});

test('lesson practice info (title, back, complete) lives inside the coach card', () => {
  const card = elementSource('coachCard');
  assert.match(card, /id="lessonPracticeBanner"/);
  assert.match(card, /id="currentLessonTitle"/);
  assert.match(card, /onclick="returnToLessonList\(\)"[^>]*>[^<]*返回關卡/);
  assert.match(card, /onclick="completeCurrentLesson\(\)"[^>]*>[^<]*完成本課/);
  assert.doesNotMatch(elementSource('sectionFreeChat'), /lessonPracticeBanner/);
});

test('single-column shell: top bar holds tabs, short status and settings; no side grid', () => {
  assert.doesNotMatch(BODY, /class="main-grid"/);
  const top = elementSource('appTopbar');
  assert.match(top, /Voice Practice/);
  assert.match(top, /id="tabBtnFree"/);
  assert.match(top, /id="tabBtnLesson"/);
  assert.match(top, /id="headerConnBadge"/);
  assert.match(top, /onclick="openSettingsModal\(\)"/);
  assert.match(HTML, /max-width:\s*760px/);
  assert.match(HTML, /--bg:\s*#FFF8F3/i);
});

test('desktop never shows web-only copy (HTTPS/PWA status, Web first-download hint)', () => {
  assert.match(elementSource('offlineStatus'), /^<[^>]*\bdata-web-only\b/);
  assert.match(elementSource('ttsModeHint'), /^<[^>]*\bdata-web-only\b/);
  assert.match(HTML, /html\[data-platform="desktop"\]\s*\[data-web-only\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(HTML, /html\[data-platform="web"\]\s*\[data-desktop-only\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(BODY, /data-desktop-only[^>]*>[^<]*語音模型/);
  const detect = fn('applyUiPlatform');
  for (const [electronAPI, expected] of [[{}, 'desktop'], [undefined, 'web']]) {
    const root = { dataset: {} };
    const context = { window: { electronAPI }, document: { documentElement: root } };
    vm.runInNewContext(`${detect}; applyUiPlatform();`, context);
    assert.equal(root.dataset.platform, expected);
  }
  assert.match(HTML, /\napplyUiPlatform\(\);/);
});

test('top status badge shows only short text; full model name goes to title', () => {
  const source = fn('updateHeaderStatusBadge');
  const run = (storage) => {
    const els = { headerConnText: { textContent: '', title: '' }, headerConnDot: { style: {} }, headerConnBadge: { title: '' } };
    const context = {
      localStorage: { getItem: k => storage[k] ?? null },
      document: { getElementById: id => els[id] || null },
      DIRECT_API_PROVIDER_ID: 'openai-compatible',
      getProviderModel: () => storage.model,
      getProviderConfig: () => ({ name: 'OpenAI-compatible API' }),
      updateActiveLanHttpWarning() {},
    };
    vm.runInNewContext(`${source}; updateHeaderStatusBadge();`, context);
    return els;
  };
  const verified = run({ vp_provider: 'openai-compatible', vp_verified_provider: 'openai-compatible', model: 'Ornith-1.5-35B-A3B-MLX-4bit' });
  assert.equal(verified.headerConnText.textContent, '模型已連線');
  assert.match(verified.headerConnBadge.title, /OpenAI-compatible API.*Ornith-1\.5-35B-A3B-MLX-4bit/);
  const unverified = run({ vp_provider: 'openai-compatible', model: 'Ornith-1.5' });
  assert.equal(unverified.headerConnText.textContent, '模型未驗證');
  assert.doesNotMatch(unverified.headerConnText.textContent, /Ornith/);
  const none = run({ model: '' });
  assert.equal(none.headerConnText.textContent, '尚未設定模型');
});

test('settings is a right drawer with three groups and fixed cancel/save footer', () => {
  const modal = elementSource('settingsModal');
  assert.match(modal, /^<div[^>]*class="[^"]*\bsettings-drawer\b/);
  const groups = [...modal.matchAll(/data-settings-group="([a-z-]+)"/g)].map(m => m[1]);
  assert.deepEqual(groups, ['llm', 'voice', 'models']);
  const part = name => modal.slice(modal.indexOf(`data-settings-group="${name}"`));
  const llm = part('llm').slice(0, part('llm').indexOf('data-settings-group="voice"'));
  const voice = part('voice').slice(0, part('voice').indexOf('data-settings-group="models"'));
  assert.match(llm, />AI 對話模型</);
  for (const id of ['providerSelect', 'directApiPreset', 'apiBaseUrl', 'apiKey', 'modelSelect', 'subscriptionGroup']) assert.match(llm, new RegExp(`id="${id}"`));
  assert.match(llm, /onclick="testApiConnection\(\)"/);
  assert.match(voice, />語音</);
  assert.match(voice, /id="ttsModeSelect"/);
  assert.match(part('models'), /id="nativeModelSettings"/);
  assert.match(HTML, /\.settings-group:has\(#nativeModelSettings\[hidden\]\)\s*\{[^}]*display:\s*none/);
  const footer = modal.slice(modal.indexOf('class="drawer-actions"'));
  assert.match(footer, /onclick="closeSettingsModal\(\)"[^>]*>取消</);
  assert.match(footer, /onclick="saveSettings\(\)"[^>]*>儲存</);
  assert.match(HTML, /@media \(max-width: 560px\)[^]*?\.settings-drawer \.modal-card\s*\{[^}]*width:\s*100%/);
});

test('UI copy is Chinese-only (no "(Start)" style bilingual labels)', () => {
  assert.doesNotMatch(HTML, /\((?:Start|Stop|Send Audio|Connection|LLM Settings|TTS|Shadowing Coach)\)/);
  assert.match(HTML, /"開始語音對話"/);
});

test('assistant messages carry a small coach avatar from renderAvatarSVG', () => {
  const append = fn('appendChat');
  assert.match(append, /renderAvatarSVG\(currentVoiceId/);
  assert.match(append, /bubbleEl\.textContent = String\(text \?\? ""\)/, 'message text stays textContent');
  assert.match(fn('openCoachModal'), /renderAvatarSVG\(p\.id\)/);
});

// --- native model panel structure -------------------------------------------------
class El {
  constructor(tag, doc) { Object.assign(this, { tagName: tag.toUpperCase(), ownerDocument: doc, children: [], attributes: new Map(), hidden: false, disabled: false, _t: '' }); }
  get textContent() { return this._t + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._t = String(v); }
  set innerHTML(_) { assert.fail('innerHTML forbidden'); }
  get value() { return this._v ?? 0; } set value(v) { this._v = v; this.setAttribute('value', v); }
  get max() { return this._m ?? 1; } set max(v) { this._m = v; this.setAttribute('max', v); }
  insertAdjacentHTML() { assert.fail('insertAdjacentHTML forbidden'); }
  replaceChildren(...c) { this.children = []; this._t = ''; c.forEach(x => this.appendChild(x)); }
  appendChild(c) { assert.ok(c instanceof El); this.children.push(c); return c; }
  append(...c) { c.forEach(x => this.appendChild(x)); }
  setAttribute(n, v) { assert.ok(!/^on/i.test(n)); this.attributes.set(n, String(v)); }
  getAttribute(n) { return this.attributes.get(n) ?? null; }
  addEventListener() {} removeEventListener() {}
  contains(n) { return this === n || this.children.some(c => c.contains(n)); }
  focus() {}
}
const all = (r) => [r, ...r.children.flatMap(all)];
const byClass = (r, cls) => all(r).filter(n => (n.getAttribute('class') || '').split(/\s+/).includes(cls));

test('native model panel renders one row per model with name, size, license, state/progress and button', async () => {
  assert.doesNotMatch(MODEL_JS, /innerHTML|insertAdjacentHTML|outerHTML/);
  const { mountNativeModelSettings } = await import(`data:text/javascript;base64,${Buffer.from(MODEL_JS).toString('base64')}`);
  const doc = { activeElement: null, createElement: t => new El(t, doc) };
  const root = doc.createElement('section');
  const overview = {
    version: 1, mode: 'runtime-only', runtime: { state: 'embedded' }, targetLanguage: 'en', enabledLanguages: ['en'],
    models: [
      { modelId: 'stt', name: 'English recognizer', kind: 'stt', languages: ['en'], bytes: 512 * 1024 ** 2,
        license: { spdx: 'MIT', url: 'https://example.test/stt' }, state: 'missing' },
      { modelId: 'tts', name: 'English voice', kind: 'tts', languages: ['en'], bytes: 2 * 1024 ** 3,
        license: { spdx: 'Apache-2.0', url: 'javascript:alert(1)' }, state: 'active' },
    ],
    installation: { actionId: 'a1', modelId: 'stt', phase: 'downloading', bytes: 256 * 1024 ** 2, total: 512 * 1024 ** 2 },
  };
  const api = { nativeModelOverview: async () => overview, installNativeModel: async () => {}, cancelNativeModelInstallAction: async () => {} };
  const ctl = mountNativeModelSettings({ root, api, setIntervalImpl: () => 1, clearIntervalImpl() {} });
  await new Promise(r => setImmediate(r));
  const rows = byClass(root, 'native-model-row');
  assert.equal(rows.length, 2);
  for (const [row, name, size, spdx] of [[rows[0], 'English recognizer', /512(\.0)? MiB/, 'MIT'], [rows[1], 'English voice', /2(\.0)? GiB/, 'Apache-2.0']]) {
    assert.equal(byClass(row, 'native-model-name')[0]?.textContent, name);
    assert.match(byClass(row, 'native-model-meta')[0]?.textContent || '', size);
    assert.match(byClass(row, 'native-model-license')[0]?.textContent || '', new RegExp(`授權.*${spdx.replace('.', '\\.')}`));
    assert.equal(byClass(row, 'native-model-state').length, 1);
  }
  // In-flight install shows progress bar and cancel inside the row being installed.
  assert.equal(all(rows[0]).filter(n => n.tagName === 'PROGRESS').length, 1);
  assert.ok(all(rows[0]).some(n => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === '取消本次安裝'));
  assert.equal(byClass(rows[1], 'native-model-state')[0].textContent, '已安裝／使用中');
  assert.equal(all(root).filter(n => n.tagName === 'A').length, 0, 'license URLs stay plain text');
  assert.ok(byClass(root, 'native-model-note').some(n => /兩包都就緒/.test(n.textContent)));
  ctl.dispose();
});

// --- round 2 ---------------------------------------------------------------------
test('round2: shadowing is a visible capsule button above the composer', () => {
  const tools = BODY.slice(BODY.indexOf('class="composer-tools"'), BODY.indexOf('id="shadowResultBox"'));
  assert.match(tools, /<button[^>]*class="[^"]*\bshadow-btn\b[^"]*"[^>]*onclick="startShadowing\(\)"[^>]*>[^]*?跟讀上一句[^]*?<\/button>/);
  assert.match(tools, /aria-hidden="true"/, 'button carries an icon');
  assert.match(HTML, /\.shadow-btn\s*\{[^}]*border:\s*1px solid[^}]*border-radius:\s*999px/);
  assert.match(elementSource('shadowResultBox'), /class="shadow-result-box"/);
});

test('round2: tts engine label is muted grey; error colour stays visible', () => {
  assert.match(HTML, /#ttsEngineLabel\s*\{[^}]*color:\s*var\(--muted\)\s*!important/);
  assert.match(HTML, /#ttsEngineLabel\[style\*="rgb\(239, 68, 68\)"\][^{]*\{[^}]*color:\s*#[0-9A-F]{6}\s*!important/i);
  assert.match(fn('setTTSEngineStatus'), /el\.style\.color = color;/, 'function behaviour unchanged');
});

test('round2: lesson practice highlights the 對話 tab, not 關卡', () => {
  const source = fn('renderPracticeTab');
  const run = tab => {
    const mk = () => ({ style: {}, classList: { on: null, toggle(_c, v) { this.on = v; } } });
    const els = { tabBtnFree: mk(), tabBtnLesson: mk(), sectionFreeChat: mk(), sectionLesson: mk(), lessonPracticeBanner: mk() };
    vm.runInNewContext(`${source}; renderPracticeTab(${JSON.stringify(tab)});`,
      { document: { getElementById: id => els[id] }, renderLessonList() {}, currentMode: '', currentLessonId: 1 });
    return els;
  };
  const p = run('lesson-practice');
  assert.equal(p.tabBtnFree.classList.on, true);
  assert.equal(p.tabBtnLesson.classList.on, false);
  assert.equal(p.sectionFreeChat.style.display, 'block');
  const l = run('lesson');
  assert.equal(l.tabBtnLesson.classList.on, true);
  assert.equal(l.tabBtnFree.classList.on, false);
});

async function mountPanel(models, installation) {
  const { mountNativeModelSettings } = await import(`data:text/javascript;base64,${Buffer.from(MODEL_JS).toString('base64')}`);
  const doc = { activeElement: null, createElement: t => new El(t, doc) };
  const root = doc.createElement('section');
  const overview = { version: 1, mode: 'runtime-only', runtime: { state: 'embedded' }, targetLanguage: 'en', enabledLanguages: ['en'], models, installation };
  const api = { nativeModelOverview: async () => overview, installNativeModel: async () => {}, cancelNativeModelInstallAction: async () => {} };
  const ctl = mountNativeModelSettings({ root, api, setIntervalImpl: () => 1, clearIntervalImpl() {} });
  await new Promise(r => setImmediate(r));
  return { root, ctl };
}
const m = (id, state) => ({ modelId: id, name: id, kind: 'stt', languages: ['en'], bytes: 1536 * 1024 ** 2,
  license: { spdx: 'MIT', url: 'https://example.test/' + id }, state });
const visibleText = n => (n.getAttribute('class') || '').includes('visually-hidden') || n.tagName === 'DETAILS' || n.hidden ? ''
  : n._t + n.children.map(visibleText).join('');
const buttonsOf = r => all(r).filter(n => n.tagName === 'BUTTON' && !n.hidden);

test('round2: model row actions are mutually exclusive by state', async () => {
  const { root, ctl } = await mountPanel([m('a', 'missing'), m('b', 'missing'), m('c', 'active')],
    { actionId: 'x', modelId: 'a', phase: 'downloading', bytes: 100 * 1024 ** 2, total: 1536 * 1024 ** 2 });
  const [a, b, c] = byClass(root, 'native-model-row');
  // downloading row: progress + amount + 取消 only
  assert.equal(all(a).filter(n => n.tagName === 'PROGRESS').length, 1);
  assert.deepEqual(buttonsOf(a).map(n => n.textContent), ['取消']);
  assert.doesNotMatch(visibleText(a), /缺模型|下載$/);
  // missing row: only 下載 (disabled while busy), no progress, no visible 缺模型 tag
  assert.deepEqual(buttonsOf(b).map(n => n.textContent), ['下載']);
  assert.equal(all(b).filter(n => n.tagName === 'PROGRESS').length, 0);
  assert.doesNotMatch(visibleText(b), /缺模型/);
  // active row: green tag only
  assert.equal(buttonsOf(c).length, 0);
  assert.match(byClass(c, 'native-model-state')[0].getAttribute('class'), /is-active/);
  // short line = size · SPDX; URL only inside <details>, never a link
  assert.equal(byClass(b, 'native-model-meta')[0].textContent, '1.5 GiB · MIT');
  assert.doesNotMatch(visibleText(root), /https:\/\//);
  assert.ok(all(root).filter(n => n.tagName === 'DETAILS').some(d => d.textContent.includes('https://example.test/b')));
  ctl.dispose();
});

test('round2: cancelling and failed rows; footer is one sentence + 更多說明', async () => {
  let r = await mountPanel([m('a', 'missing')], { actionId: 'x', modelId: 'a', phase: 'cancelling', bytes: 0, total: 1 });
  let row = byClass(r.root, 'native-model-row')[0];
  assert.deepEqual(buttonsOf(row).map(n => [n.textContent, n.disabled]), [['取消中…', true]]);
  r.ctl.dispose();
  r = await mountPanel([m('a', 'missing')], { actionId: 'x', modelId: 'a', phase: 'failed', errorCode: 'E1' });
  row = byClass(r.root, 'native-model-row')[0];
  assert.deepEqual(buttonsOf(row).map(n => n.textContent), ['重試']);
  assert.match(visibleText(row), /失敗/);
  const root = r.root;
  assert.ok(all(root).some(n => n._t === '語音辨識與語音合成各裝好一個，即可語音對話；安裝後請完整結束 App 再開啟。'));
  const more = all(root).find(n => n.tagName === 'DETAILS' && /更多說明/.test(n.children[0]?.textContent));
  assert.ok(more, 'footer details');
  assert.match(more.textContent, /兩包都就緒/);
  assert.match(more.textContent, /英文/);
  assert.doesNotMatch(visibleText(root), /離線重用|metadata/);
  assert.match(byClass(root, 'native-model-reload')[0].getAttribute('class'), /link-btn/);
  r.ctl.dispose();
});

test('round3: file:// dev hint is web-only, never shown inside the desktop App', () => {
  const src = HTML.slice(HTML.indexOf('window.location.protocol === "file:"') - 200, HTML.indexOf('npm run start:web') + 80);
  assert.match(src, /protocol === "file:" && !window\.electronAPI && !iosNativeBridge\(\)/, 'nor inside the iOS app');
});

test('round3: auto TTS option label does not mention Web on desktop', () => {
  const opt = HTML.match(/<option value="auto">([^<]*)<\/option>/);
  assert.ok(opt, 'auto option missing');
  assert.doesNotMatch(opt[1], /Web/);
});
