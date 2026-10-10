'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML_PATH = path.join(__dirname, '..', 'apps', 'web', 'index.html');

function extractCoachScript() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Coach data now comes from runtime/coach-profiles.js plus the PERSONAS view and helpers.
  const profiles = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'runtime', 'coach-profiles.js'), 'utf8');
  const personasMatch = html.match(/let coachStore = loadCoachStore\(\);[\s\S]*?function currentCoach\(\) \{[^\n]*\}/);
  const renderSvgMatch = html.match(/function renderAvatarSVG\([\s\S]*?\n\}/);
  const updateCoachMatch = html.match(/function updateCoachUI\([\s\S]*?\n\}/);

  if (!personasMatch || !renderSvgMatch || !updateCoachMatch) {
    throw new Error('FAILED_TO_EXTRACT_COACH_FUNCTIONS_FROM_HTML');
  }

  return `var window = globalThis; var localStorage = { getItem: () => null, setItem() {} };\n${profiles}\nlet currentVoiceId = "af_heart";\n${personasMatch[0]}\n${renderSvgMatch[0]}\n${updateCoachMatch[0]}`;
}

test('updateCoachUI does not throw when chatBox is cleared and msgAvatarIcon is null', () => {
  const code = extractCoachScript();
  const elements = new Map();

  // Create a simulated DOM where msgAvatarIcon is missing (as happens after chatBox.replaceChildren())
  const domElements = {
    avatarStage: { innerHTML: '' },
    coachHeaderTag: { innerText: '' },
    coachTitle: { innerText: '' },
    coachDesc: { innerText: '' },
    // msgAvatarIcon is NULL (missing from DOM)
    coachCard: { style: { setProperty: () => {} } },
    statusLabel: { innerText: '' },
    statusPill: { style: { color: '', borderColor: '' } }
  };

  for (const [id, el] of Object.entries(domElements)) {
    elements.set(id, el);
  }

  const sandbox = {
    document: {
      getElementById: id => elements.get(id) || null
    },
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  // Calling updateCoachUI("thinking") should not throw despite msgAvatarIcon being null
  assert.doesNotThrow(() => {
    vm.runInContext('updateCoachUI("thinking")', sandbox);
  });

  // Verify status was updated
  assert.equal(sandbox.document.getElementById('statusLabel').innerText, '正在思考…');
});

test('updateCoachUI handles completely empty DOM gracefully', () => {
  const code = extractCoachScript();
  const sandbox = {
    document: {
      getElementById: () => null
    },
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  // When no elements exist at all (e.g. during tear-down or on foreign tab), should not throw
  assert.doesNotThrow(() => {
    vm.runInContext('updateCoachUI("idle")', sandbox);
    vm.runInContext('updateCoachUI("speaking")', sandbox);
    vm.runInContext('updateCoachUI("listening")', sandbox);
  });
});

test('updateCoachUI falls back safely when currentVoiceId is invalid', () => {
  const code = extractCoachScript();
  const elements = {
    statusLabel: { innerText: '' },
    statusPill: { style: { color: '', borderColor: '' } }
  };

  const sandbox = {
    document: {
      getElementById: id => elements[id] || null
    },
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  assert.doesNotThrow(() => {
    vm.runInContext('currentVoiceId = "unknown_persona"; updateCoachUI("idle");', sandbox);
  });

  assert.equal(elements.statusLabel.innerText, '隨時可以開始');
});
