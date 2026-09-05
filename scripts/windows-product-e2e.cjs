'use strict';

/**
 * windows-product-e2e.cjs
 * Zero-dependency packaged Electron UI driver using Node 24 native WebSocket and Chrome DevTools Protocol (CDP).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.idCounter = 1;
    this.pending = new Map();
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.ws) this.ws.close();
        reject(new Error(`WebSocket connection timeout after ${timeoutMs}ms: ${this.wsUrl}`));
      }, timeoutMs);

      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (err) {
        clearTimeout(timer);
        return reject(err);
      }

      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };

      this.ws.onerror = err => {
        clearTimeout(timer);
        reject(err);
      };

      this.ws.onmessage = event => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) {
              rej(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
            } else {
              res(msg.result);
            }
          }
        } catch (parseErr) {
          console.error('Failed to parse CDP message:', parseErr);
        }
      };
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.idCounter++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: res => {
          clearTimeout(timer);
          resolve(res);
        },
        reject: rej => {
          clearTimeout(timer);
          reject(rej);
        },
      });

      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 30000) {
    const res = await this.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      timeoutMs,
    );

    if (res?.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`Evaluation failed: ${desc}`);
    }

    return res?.result?.value;
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
  }
}

async function getDebuggerUrl(port, retries = 30, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const data = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json/list`, res => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Unexpected DevTools HTTP status: ${res.statusCode}`));
            return;
          }
          let body = '';
          let bodyBytes = 0;
          res.on('data', chunk => {
            bodyBytes += chunk.length;
            if (bodyBytes > 256 * 1024) {
              res.destroy(new Error('DevTools target list exceeds 256 KiB'));
              return;
            }
            body += chunk;
          });
          res.on('end', () => resolve(body));
          res.on('error', reject);
        });
        req.setTimeout(2000, () => req.destroy(new Error('DevTools target list request timed out')));
        req.on('error', reject);
      });

      const targets = JSON.parse(data);
      const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pageTarget) {
        return {
          title: pageTarget.title,
          url: pageTarget.url,
          wsUrl: pageTarget.webSocketDebuggerUrl,
        };
      }
    } catch (_) {
      // Retry
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Failed to find page target on port ${port} after ${retries} attempts`);
}

function assertTrustedDebugTarget(target, expectedPort) {
  let parsed;
  try { parsed = new URL(target.url); }
  catch { throw new Error('UNTRUSTED_DEBUG_TARGET_URL'); }
  const normalizedPath = decodeURIComponent(parsed.pathname).replace(/\\/g, '/');
  if (parsed.protocol !== 'file:' || !normalizedPath.endsWith('/apps/web/index.html')) {
    throw new Error(`UNTRUSTED_DEBUG_TARGET_URL:${target.url}`);
  }
  let ws;
  try { ws = new URL(target.wsUrl); }
  catch { throw new Error('UNTRUSTED_DEBUG_WEBSOCKET_URL'); }
  if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' || Number(ws.port) !== expectedPort) {
    throw new Error('UNTRUSTED_DEBUG_WEBSOCKET_URL');
  }
}

async function waitForDownloadedJson(downloadDir, before, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = fs.readdirSync(downloadDir)
      .filter(name => name.endsWith('.json') && !before.has(name));
    if (files.length === 1) return path.join(downloadDir, files[0]);
    if (files.length > 1) throw new Error('AMBIGUOUS_LESSON_EXPORT_DOWNLOAD');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('LESSON_EXPORT_DOWNLOAD_TIMEOUT');
}

async function setLessonImportFile(client, filePath, mode) {
  await client.evaluate(`
    (() => {
      const modeSelect = document.getElementById('lessonImportMode');
      if (!modeSelect) throw new Error('LESSON_IMPORT_MODE_MISSING');
      modeSelect.value = ${JSON.stringify(mode)};
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      const result = document.getElementById('lessonManagerResult');
      if (result) result.textContent = '';
    })()
  `);
  const remote = await client.send('Runtime.evaluate', {
    expression: "document.getElementById('lessonImportFile')",
    returnByValue: false,
  });
  if (remote?.exceptionDetails || !remote?.result?.objectId) {
    throw new Error('LESSON_IMPORT_FILE_INPUT_MISSING');
  }
  await client.send('DOM.setFileInputFiles', {
    files: [path.resolve(filePath)],
    objectId: remote.result.objectId,
  });
}

async function waitForLessonResult(client, expectedPattern, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await client.evaluate("document.getElementById('lessonManagerResult')?.textContent || ''");
    if (expectedPattern.test(text)) return text;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`LESSON_IMPORT_RESULT_TIMEOUT:${expectedPattern}`);
}

function isProviderErrorReply(text) {
  return /MODEL_REQUIRED|Authentication failed|Could not (?:reach|connect)|subscription option requires|GEMINI_|連線失敗|無法連線/i.test(String(text));
}

function isExpectedChallengeReply(text, expectedToken) {
  const normalized = String(text || '').trim();
  return normalized.includes(expectedToken) && !isProviderErrorReply(normalized);
}

async function runTests({ port, mode, artifactDir }) {
  console.log(`[E2E] Connecting to packaged app on port ${port} (mode: ${mode})...`);
  const target = await getDebuggerUrl(port);
  assertTrustedDebugTarget(target, port);
  console.log(`[E2E] Found target: "${target.title}"`);
  console.log('[E2E] Target URL validated as packaged file URL (absolute path suppressed)');

  const client = new CdpClient(target.wsUrl);
  await client.connect();
  console.log('[E2E] WebSocket connected to Chrome DevTools Protocol.');

  try {
    // 1. Contract & App Shell Verification
    const title = await client.evaluate('document.title');
    console.log(`[E2E] Page document.title: "${title}"`);
    if (!title.includes('Voice Practice')) {
      throw new Error(`Unexpected document title: ${title}`);
    }
    console.log('DRIVER_CONNECT_OK');
    console.log('PACKAGED_APP_TITLE_OK');

    const domCheck = await client.evaluate(`
      (() => {
        const required = ['chatBox', 'startBtn', 'userTextInput', 'tabBtnFree', 'tabBtnLesson', 'coachCard', 'headerConnBadge'];
        return required.every(id => document.getElementById(id) !== null);
      })()
    `);
    if (!domCheck) {
      throw new Error('Required App Shell DOM elements missing');
    }
    console.log('APP_SHELL_DOM_OK');

    // If only ContractOnly requested, finish here
    if (mode === 'ContractOnly') {
      return { success: true };
    }

    if (mode === 'NativeVoice') {
      console.log('[E2E] Running NativeVoice lane...');
      const health = await client.evaluate(`
        (async () => {
          if (!window.electronAPI || typeof window.electronAPI.runtimeHealth !== 'function') {
            return { error: 'NO_ELECTRON_API' };
          }
          try {
            const h = await window.electronAPI.runtimeHealth();
            return { success: true, health: h };
          } catch (e) {
            return { error: String(e?.message || e) };
          }
        })()
      `);
      if (!health?.success || !health.health) {
        throw new Error(`Native voice health check failed: ${health?.error}`);
      }
      const h = health.health;
      console.log(`[E2E] Native voice health: platform=${h.platform} arch=${h.arch} tts=${h.selectedTts} ep=${h.executionProvider}`);
      if (h.platform !== 'windows') throw new Error(`Unexpected platform: ${h.platform}`);
      if (h.arch !== 'x64') throw new Error(`Unexpected arch: ${h.arch}`);
      if (h.selectedTts !== 'kokoro-onnx') throw new Error(`Unexpected selectedTts: ${h.selectedTts}`);
      if (h.executionProvider !== null && h.executionProvider !== 'CPUExecutionProvider' && h.executionProvider !== 'DmlExecutionProvider') {
        throw new Error(`Unexpected executionProvider: ${h.executionProvider}`);
      }
      console.log('NATIVE_VOICE_HEALTH_OK');

      const synthResult = await client.evaluate(`
        (async () => {
          const t0 = performance.now();
          const res = await window.electronAPI.synthKokoro({
            text: 'Hello from Windows native voice runtime',
            voice: 'af_heart',
            speed: 1.0,
          });
          const t1 = performance.now();
          return {
            audioLength: res?.audio?.length || 0,
            format: res?.format,
            duration: res?.duration,
            elapsedMs: t1 - t0,
            executionProvider: res?.executionProvider,
          };
        })()
      `);
      if (!synthResult || synthResult.audioLength < 1000) {
        throw new Error(`Native synthesis returned empty or invalid audio: ${JSON.stringify(synthResult)}`);
      }
      if (synthResult.executionProvider !== 'CPUExecutionProvider' && synthResult.executionProvider !== 'DmlExecutionProvider') {
        throw new Error(`Native synthesis did not report an actual execution provider: ${synthResult.executionProvider}`);
      }
      const warmedHealth = await client.evaluate(`window.electronAPI.runtimeHealth()`);
      if (warmedHealth?.executionProvider !== synthResult.executionProvider) {
        throw new Error(`Post-synthesis health provider mismatch: ${warmedHealth?.executionProvider} != ${synthResult.executionProvider}`);
      }
      console.log(`[E2E] Native synth completed in ${Math.round(synthResult.elapsedMs)}ms, audio length ${synthResult.audioLength} chars`);
      console.log('NATIVE_VOICE_SYNTH_OK');

      const labelText = await client.evaluate(`document.getElementById('ttsEngineLabel')?.textContent || ''`);
      console.log(`[E2E] TTS UI label: "${labelText}"`);
      if (!labelText.includes('Kokoro Native')) {
        throw new Error(`UI label does not reflect native voice: ${labelText}`);
      }
      console.log('NATIVE_VOICE_UI_STATUS_OK');
      console.log('NATIVE_VOICE_ALL_OK');
      return { success: true };
    }

    if (mode === 'CleanClose') {
      await client.evaluate(`window.close()`);
      return { success: true };
    }

    if (mode === 'RestartCheck') {
      const expectLlamaRestart = await client.evaluate(`localStorage.getItem('vp_e2e_expect_llama_restart') === 'true'`);
      const expectedCompletedLesson = await client.evaluate(`localStorage.getItem('vp_e2e_expect_completed_lesson')`);
      if (expectedCompletedLesson) {
        const completedLessons = await client.evaluate(`localStorage.getItem('vp_completed_lessons')`);
        if (!completedLessons || !completedLessons.includes(expectedCompletedLesson)) {
          throw new Error(`Lesson progress did not persist across restart: ${completedLessons}`);
        }
        console.log('LESSON_PROGRESS_RESTART_OK');
      }
      const expectedCustomLesson = await client.evaluate(`localStorage.getItem('vp_e2e_expect_custom_lesson')`);
      if (expectedCustomLesson) {
        const storedLessons = await client.evaluate(`localStorage.getItem('vp_lessons_v1')`);
        if (!storedLessons || !storedLessons.includes(expectedCustomLesson)) {
          throw new Error('Custom lesson library did not persist across restart');
        }
        console.log('LESSON_LIBRARY_RESTART_OK');
      }
      if (expectLlamaRestart) {
        const savedEndpoint = await client.evaluate(`localStorage.getItem('vp_baseUrl')`);
        const savedModel = await client.evaluate(`localStorage.getItem('vp_model')`);
        if (savedEndpoint !== 'http://127.0.0.1:8080/v1' || savedModel !== 'ornith-9b') {
          throw new Error(`Restart persistence mismatch: ${savedEndpoint} / ${savedModel}`);
        }
        const initialCount = await client.evaluate(`document.querySelectorAll('#chatBox .chat-msg.assistant').length`);
        await client.evaluate(`
          (() => {
            const inp = document.getElementById('userTextInput');
            inp.value = 'Reply with exactly VP_E2E_RESTART_OK';
            document.querySelector('.text-input-row button').click();
          })()
        `);
        let chatOk = false;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 500));
          const count = await client.evaluate(`document.querySelectorAll('#chatBox .chat-msg.assistant').length`);
          if (count > initialCount) {
            const latestText = await client.evaluate(`
              (() => {
                const messages = document.querySelectorAll('#chatBox .chat-msg.assistant .msg-bubble');
                return messages[messages.length - 1]?.textContent?.trim() || '';
              })()
            `);
            if (isExpectedChallengeReply(latestText, 'VP_E2E_RESTART_OK')) {
              chatOk = true;
              break;
            }
          }
        }
        if (!chatOk) throw new Error('Timeout waiting for post-restart chat reply');
        console.log('LLAMACPP_UI_RESTART_OK');
      }
      await client.evaluate(`window.close()`);
      return { success: true };
    }

    // 2. Live Local LLM Verification (llama.cpp)
    if (mode === 'LiveLocalLlm' || mode === 'All') {
      console.log('\n==> Executing LiveLocalLlm test suite...');

      // Install fetch and dialog monitor in renderer
      await client.evaluate(`
        window.alert = () => {};
        window.confirm = () => true;
        window.__e2eVisibleButton = (label, errorCode) => {
          const button = [...document.querySelectorAll('button')]
            .find(candidate => candidate.getClientRects().length > 0 && candidate.textContent?.includes(label));
          if (!button) throw new Error(errorCode);
          return button;
        };
        window.__e2e_fetch_count = 0;
        if (!window.__e2e_fetch_patched) {
          window.__e2e_fetch_patched = true;
          const orig = window.fetch;
          window.fetch = function(...args) {
            window.__e2e_fetch_count++;
            return orig.apply(this, args);
          };
        }
      `);

      // Open settings modal
      await client.evaluate(`window.__e2eVisibleButton('設定大腦 AI 模型', 'MISSING_VISIBLE_SETTINGS_TRIGGER').click()`);

      // Configure provider: openai-compatible, endpoint: http://127.0.0.1:8080/v1
      await client.evaluate(`
        (() => {
          const prov = document.getElementById('providerSelect');
          prov.value = 'openai-compatible';
          prov.dispatchEvent(new Event('change'));

          const urlInput = document.getElementById('apiBaseUrl');
          urlInput.value = 'http://127.0.0.1:8080/v1';
          urlInput.dispatchEvent(new Event('input'));

          const keyInput = document.getElementById('apiKey');
          keyInput.value = '';
          keyInput.dispatchEvent(new Event('input'));
        })()
      `);

      // Fetch models from provider
      await client.evaluate(`window.__e2eVisibleButton('從端點取得模型', 'MISSING_VISIBLE_MODEL_DISCOVERY_TRIGGER').click()`);

      // Wait for modelSelect to include ornith-9b
      let modelFound = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        const options = await client.evaluate(`
          Array.from(document.getElementById('modelSelect').options).map(o => o.value)
        `);
        if (options.includes('ornith-9b')) {
          modelFound = true;
          break;
        }
      }

      if (!modelFound) {
        throw new Error('Model ornith-9b not found in modelSelect dropdown');
      }
      console.log('LLAMACPP_UI_MODELS_OK:ornith-9b');

      // Select ornith-9b and save settings
      await client.evaluate(`
        (() => {
          const sel = document.getElementById('modelSelect');
          sel.value = 'ornith-9b';
          sel.dispatchEvent(new Event('change'));
          window.__e2eVisibleButton('儲存設定', 'MISSING_VISIBLE_SAVE_TRIGGER').click();
        })()
      `);

      // Verify saved in localStorage after the visible Save handler completes.
      let savedEndpoint = null;
      let savedModel = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        savedEndpoint = await client.evaluate(`localStorage.getItem('vp_baseUrl')`);
        savedModel = await client.evaluate(`localStorage.getItem('vp_model')`);
        if (savedEndpoint === 'http://127.0.0.1:8080/v1' && savedModel === 'ornith-9b') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (savedEndpoint !== 'http://127.0.0.1:8080/v1' || savedModel !== 'ornith-9b') {
        throw new Error(`Settings not saved correctly: ${savedEndpoint} / ${savedModel}`);
      }
      await client.evaluate(`localStorage.setItem('vp_e2e_expect_llama_restart', 'true')`);

      // Initial assistant message count
      const initialAssistantCount = await client.evaluate(`
        document.querySelectorAll('#chatBox .chat-msg.assistant').length
      `);

      // Chat 1: Send text
      console.log('[E2E] Sending Chat 1 via UI...');
      await client.evaluate(`
        (() => {
          const inp = document.getElementById('userTextInput');
          inp.value = 'Reply with exactly VP_E2E_CHAT_1_OK';
          window.__e2eVisibleButton('發送', 'MISSING_VISIBLE_SEND_TRIGGER').click();
        })()
      `);

      // Wait for assistant reply
      let chat1Ok = false;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        const count = await client.evaluate(`
          document.querySelectorAll('#chatBox .chat-msg.assistant').length
        `);
        if (count > initialAssistantCount) {
          const latestText = await client.evaluate(`
            (() => {
              const msgs = document.querySelectorAll('#chatBox .chat-msg.assistant .msg-bubble');
              return msgs[msgs.length - 1]?.textContent?.trim() || '';
            })()
          `);
          if (isExpectedChallengeReply(latestText, 'VP_E2E_CHAT_1_OK')) {
            chat1Ok = true;
            break;
          }
        }
      }

      if (!chat1Ok) {
        throw new Error('Timeout waiting for Chat 1 response from llama.cpp');
      }
      console.log('LLAMACPP_UI_CHAT_1_OK');

      // Chat 2: Send second text
      console.log('[E2E] Sending Chat 2 via UI...');
      await client.evaluate(`
        (() => {
          const inp = document.getElementById('userTextInput');
          inp.value = 'Reply with exactly VP_E2E_CHAT_2_OK';
          window.__e2eVisibleButton('發送', 'MISSING_VISIBLE_SEND_TRIGGER').click();
        })()
      `);

      let chat2Ok = false;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        const count = await client.evaluate(`
          document.querySelectorAll('#chatBox .chat-msg.assistant').length
        `);
        if (count > initialAssistantCount + 1) {
          const latestText = await client.evaluate(`
            (() => {
              const msgs = document.querySelectorAll('#chatBox .chat-msg.assistant .msg-bubble');
              return msgs[msgs.length - 1]?.textContent?.trim() || '';
            })()
          `);
          if (isExpectedChallengeReply(latestText, 'VP_E2E_CHAT_2_OK')) {
            chat2Ok = true;
            break;
          }
        }
      }

      if (!chat2Ok) {
        throw new Error('Timeout waiting for Chat 2 response from llama.cpp');
      }
      console.log('LLAMACPP_UI_CHAT_2_OK');

      // Verify zero renderer fetches
      const fetchCount = await client.evaluate(`window.__e2e_fetch_count`);
      if (fetchCount !== 0) {
        throw new Error(`Expected 0 renderer direct fetches, got: ${fetchCount}`);
      }
      console.log('RENDERER_DIRECT_FETCHES=0');
      console.log('LOCAL_PROVIDER_RUNTIME_CREDENTIAL_READS=NOT_INSTRUMENTED');
    }

    // 3. Core Product Workflows
    if (mode === 'CoreProduct' || mode === 'All') {
      console.log('\n==> Executing CoreProduct test suite...');

      // Switch to Lesson Tab
      await client.evaluate(`switchTab('lesson')`);
      const lessonCount = await client.evaluate(`document.getElementById('lessonCount').textContent`);
      if (lessonCount !== '7') {
        throw new Error(`Expected 7 initial lessons, got: ${lessonCount}`);
      }

      // Start specific lesson
      await client.evaluate(`startSpecificLesson('self-intro')`);
      const isBannerVisible = await client.evaluate(`
        document.getElementById('lessonPracticeBanner').style.display !== 'none'
      `);
      if (!isBannerVisible) {
        throw new Error('Lesson practice banner did not become visible');
      }
      console.log('BUILTIN_LESSONS_OK');

      // Exercise the actual download and file-input product boundaries.
      if (!artifactDir || !path.isAbsolute(artifactDir)) throw new Error('MISSING_ABSOLUTE_ARTIFACT_DIR');
      fs.mkdirSync(artifactDir, { recursive: true });
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: artifactDir });
      await client.evaluate(`openLessonManager()`);
      const exportJson = await client.evaluate(`document.getElementById('lessonJsonEditor').value`);
      const parsed = JSON.parse(exportJson);
      const lessonArray = Array.isArray(parsed) ? parsed : parsed.lessons;
      if (!Array.isArray(lessonArray) || lessonArray.length !== 7) {
        throw new Error(`Invalid export JSON structure: length ${lessonArray?.length}`);
      }
      const beforeDownloads = new Set(fs.readdirSync(artifactDir));
      await client.evaluate(`
        (() => {
          const button = [...document.querySelectorAll('#lessonManagerModal button')]
            .find(candidate => candidate.textContent.includes('匯出'));
          if (!button) throw new Error('LESSON_EXPORT_BUTTON_MISSING');
          button.click();
        })()
      `);
      const downloadedPath = await waitForDownloadedJson(artifactDir, beforeDownloads);
      const downloaded = JSON.parse(fs.readFileSync(downloadedPath, 'utf8'));
      if (JSON.stringify(downloaded) !== JSON.stringify(parsed)) {
        throw new Error('LESSON_EXPORT_CONTENT_MISMATCH');
      }
      console.log('LESSON_EXPORT_DOWNLOAD_OK');

      // Replace through the hidden file input using the file that the product downloaded.
      await setLessonImportFile(client, downloadedPath, 'replace');
      await waitForLessonResult(client, /已取代/);
      if (await client.evaluate(`document.getElementById('lessonCount').textContent`) !== '7') {
        throw new Error('LESSON_IMPORT_REPLACE_COUNT_MISMATCH');
      }
      console.log('LESSON_IMPORT_REPLACE_OK');

      const customLesson = {
        id: 'e2e-custom-lesson',
        title: 'E2E Custom Lesson',
        level: 'Beginner',
        objectives: ['Synthetic persistence check'],
        opening_line: 'Synthetic lesson opening',
      };
      const mergePath = path.join(artifactDir, 'merge-fixture.json');
      fs.writeFileSync(mergePath, JSON.stringify([customLesson]));
      await setLessonImportFile(client, mergePath, 'merge');
      await waitForLessonResult(client, /已合併/);
      if (await client.evaluate(`document.getElementById('lessonCount').textContent`) !== '8') {
        throw new Error('LESSON_IMPORT_MERGE_COUNT_MISMATCH');
      }
      console.log('LESSON_IMPORT_MERGE_OK');

      const assertRejectedImport = async (name, content, expectedPattern, marker) => {
        const fixturePath = path.join(artifactDir, `${name}.json`);
        fs.writeFileSync(fixturePath, content);
        await setLessonImportFile(client, fixturePath, 'merge');
        await waitForLessonResult(client, expectedPattern);
        if (await client.evaluate(`document.getElementById('lessonCount').textContent`) !== '8') {
          throw new Error(`${name.toUpperCase()}_IMPORT_MUTATED_LIBRARY`);
        }
        console.log(marker);
      };
      await assertRejectedImport('invalid', JSON.stringify({ lessons: 'invalid' }), /❌/, 'LESSON_IMPORT_INVALID_REJECTED');
      await assertRejectedImport('duplicate', JSON.stringify([customLesson, customLesson]), /❌/, 'LESSON_IMPORT_DUPLICATE_REJECTED');
      await assertRejectedImport('oversize', 'x'.repeat((1024 * 1024) + 1), /不可超過 1 MB/, 'LESSON_IMPORT_OVERSIZE_REJECTED');

      await client.evaluate(`localStorage.setItem('vp_e2e_expect_custom_lesson', 'e2e-custom-lesson')`);
      console.log('LESSON_IMPORT_EXPORT_ROUNDTRIP_OK');

      // Test lesson completion & progress tracking
      await client.evaluate(`startSpecificLesson('self-intro')`);
      await client.evaluate(`completeCurrentLesson()`);
      const completedList = await client.evaluate(`localStorage.getItem('vp_completed_lessons')`);
      if (!completedList || !completedList.includes('self-intro')) {
        throw new Error(`Expected 'self-intro' in completed lessons, got: ${completedList}`);
      }
      await client.evaluate(`localStorage.setItem('vp_e2e_expect_completed_lesson', 'self-intro')`);
      console.log('LESSON_PROGRESS_PERSISTENCE_OK');

      // Test the real product scoring and rendering path with a deterministic transcript fixture.
      const shadowAssessment = await client.evaluate(`
        (() => {
          switchTab('free');
          const box = document.getElementById('shadowResultBox');
          box.style.display = 'block';
          const assessment = renderShadowingResult(box, 'Hello there.', 'hello there');
          return {
            score: assessment.score,
            summary: box.firstElementChild?.textContent || '',
            chipCount: box.querySelectorAll('.word-chip').length,
          };
        })()
      `);
      if (shadowAssessment.score !== 100
          || !shadowAssessment.summary.includes('100%')
          || shadowAssessment.chipCount !== 2) {
        throw new Error(`Unexpected product shadowing assessment: ${JSON.stringify(shadowAssessment)}`);
      }
      console.log('SHADOWING_FIXTURE_SCORE_OK');
      console.log('CORE_PRODUCT_FLOWS_OK');
    }

    // 4. Resilience & Lifecycles
    if (mode === 'Resilience' || mode === 'All') {
      console.log('\n==> Executing Resilience test suite...');

      // Verify the bundled UI after an actual CDP offline reload.
      await client.send('Network.enable');
      await client.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0,
        connectionType: 'none',
      });
      await client.send('Page.reload', { ignoreCache: true });
      let offlineReady = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 200));
        try {
          offlineReady = await client.evaluate(`
            document.readyState === 'complete'
              && Boolean(document.getElementById('chatBox'))
              && Boolean(document.getElementById('providerSelect'))
          `);
        } catch (_) {
          offlineReady = false;
        }
        if (offlineReady) break;
      }
      await client.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        connectionType: 'none',
      });
      if (!offlineReady) throw new Error('Bundled UI did not recover after an offline reload');
      await client.evaluate(`
        window.alert = () => {};
        window.confirm = () => true;
        window.__e2eVisibleButton = (label, errorCode) => {
          const button = [...document.querySelectorAll('button')]
            .find(candidate => candidate.getClientRects().length > 0 && candidate.textContent?.includes(label));
          if (!button) throw new Error(errorCode);
          return button;
        };
      `);
      console.log('OFFLINE_BUNDLED_UI_OK');

      // Test invalid-port connection error display through visible product controls.
      await client.evaluate(`
        (() => {
          window.__e2eVisibleButton('設定大腦 AI 模型', 'MISSING_VISIBLE_SETTINGS_TRIGGER').click();
          const provider = document.getElementById('providerSelect');
          provider.value = 'openai-compatible';
          provider.dispatchEvent(new Event('change'));
          const urlInput = document.getElementById('apiBaseUrl');
          urlInput.value = 'http://127.0.0.1:59999/v1';
          urlInput.dispatchEvent(new Event('input'));
          const keyInput = document.getElementById('apiKey');
          keyInput.value = '';
          keyInput.dispatchEvent(new Event('input'));
          window.__e2eVisibleButton('測試連線', 'MISSING_VISIBLE_CONNECTION_TEST_TRIGGER').click();
        })()
      `);

      let errSeen = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 200));
        const resText = await client.evaluate(`document.getElementById('testConnResult').textContent`);
        if (resText && resText.includes('❌')) {
          if (!resText.includes('C:\\Users')
              && !resText.includes('Bearer')
              && !/sk-[A-Za-z0-9]/.test(resText)) {
            errSeen = true;
            break;
          }
        }
      }
      if (!errSeen) {
        throw new Error('Expected a sanitized connection error, but no actionable error was rendered');
      }
      console.log('INVALID_PORT_ERROR_UI_OK');

      // Restore the supported local endpoint and model through visible controls.
      await client.evaluate(`
        (() => {
          const urlInput = document.getElementById('apiBaseUrl');
          urlInput.value = 'http://127.0.0.1:8080/v1';
          urlInput.dispatchEvent(new Event('input'));
          window.__e2eVisibleButton('從端點取得模型', 'MISSING_VISIBLE_MODEL_DISCOVERY_TRIGGER').click();
        })()
      `);
      let recoveryModelFound = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const options = await client.evaluate(`Array.from(document.getElementById('modelSelect').options).map(option => option.value)`);
        if (options.includes('ornith-9b')) {
          recoveryModelFound = true;
          break;
        }
      }
      if (!recoveryModelFound) throw new Error('Recovery model ornith-9b not found');
      await client.evaluate(`
        (() => {
          const model = document.getElementById('modelSelect');
          model.value = 'ornith-9b';
          model.dispatchEvent(new Event('change'));
          window.__e2eVisibleButton('儲存設定', 'MISSING_VISIBLE_SAVE_TRIGGER').click();
        })()
      `);
      let recoverySettingsSaved = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const savedEndpoint = await client.evaluate(`localStorage.getItem('vp_baseUrl')`);
        const savedModel = await client.evaluate(`localStorage.getItem('vp_model')`);
        if (savedEndpoint === 'http://127.0.0.1:8080/v1' && savedModel === 'ornith-9b') {
          recoverySettingsSaved = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!recoverySettingsSaved) throw new Error('Recovery settings were not saved');

      const recoveryInitialCount = await client.evaluate(`document.querySelectorAll('#chatBox .chat-msg.assistant').length`);
      await client.evaluate(`
        (() => {
          const input = document.getElementById('userTextInput');
          input.value = 'Reply with exactly VP_E2E_RECOVERY_OK';
          window.__e2eVisibleButton('發送', 'MISSING_VISIBLE_SEND_TRIGGER').click();
        })()
      `);
      let recovered = false;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        const count = await client.evaluate(`document.querySelectorAll('#chatBox .chat-msg.assistant').length`);
        if (count > recoveryInitialCount) {
          const latestText = await client.evaluate(`
            (() => {
              const messages = document.querySelectorAll('#chatBox .chat-msg.assistant .msg-bubble');
              return messages[messages.length - 1]?.textContent?.trim() || '';
            })()
          `);
          if (isExpectedChallengeReply(latestText, 'VP_E2E_RECOVERY_OK')) {
            recovered = true;
            break;
          }
        }
      }
      if (!recovered) throw new Error('llama.cpp chat did not recover after restoring the supported endpoint');
      console.log('ERROR_RECOVERY_CHAT_OK');
      console.log('RESILIENCE_FLOWS_OK');
    }

    console.log('\n[E2E] All requested tests passed successfully.');
    return { success: true };
  } finally {
    client.close();
  }
}

// Command-line entry point
async function main() {
  const args = process.argv.slice(2);
  let port = 0;
  let mode = 'All';
  let artifactDir = null;

  for (const arg of args) {
    if (arg.startsWith('--port=')) {
      port = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--mode=')) {
      mode = arg.split('=')[1];
    } else if (arg.startsWith('--artifact-dir=')) {
      artifactDir = arg.slice('--artifact-dir='.length);
    }
  }

  if (!port) {
    console.error('Usage: node scripts/windows-product-e2e.cjs --port=<port> [--mode=ContractOnly|LiveLocalLlm|CoreProduct|Resilience|All] [--artifact-dir=<absolute-path>]');
    process.exit(1);
  }
  if ((mode === 'CoreProduct' || mode === 'All') && (!artifactDir || !path.isAbsolute(artifactDir))) {
    console.error('CoreProduct mode requires --artifact-dir=<absolute-path>');
    process.exit(1);
  }

  try {
    await runTests({ port, mode, artifactDir });
    process.exit(0);
  } catch (err) {
    console.error(`\n[E2E Error] ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { CdpClient, getDebuggerUrl, runTests, assertTrustedDebugTarget, isProviderErrorReply, isExpectedChallengeReply };
