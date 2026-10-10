"use strict";
/**
 * Shared Test Mock Helpers for Acceptance Runner Integration Tests
 * Extracted into a standalone module to prevent test re-registration side effects (R9 Review F6).
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const os = require("node:os");

function resolveGitHead() {
  try {
    const { execSync } = require("node:child_process");
    return execSync("git rev-parse HEAD", { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const DUMMY_HEX_64 = "a".repeat(64);
const RESOLVED_HEAD = resolveGitHead();
const CODE_TESTED_SHA = process.env.CODE_TESTED_SHA || RESOLVED_HEAD || "7f8fbfa655eebf9bdc6a22211c6acd8958099d1e";
const PACKET_SHA = "4a741e4aa086e4ff283bfe511fbe377b6d32e87d";
const ROUND = "R18";

const {
  canonicalReceiptPayload,
  computeReceiptSignature
} = require("../../scripts/run-full-acceptance-r3.cjs");

const VALID_PNG_BUF = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function createMockProc(pid = 99990, options = {}) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.launchNonce = options.launchNonce || `mock-launch-${pid}-${Date.now()}`;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stdout.destroyed = false;
  proc.stdout.closed = false;
  proc.stdout.readableEnded = false;
  proc.stdout.resume = function() {
    setImmediate(() => {
      this.readableEnded = true;
      this.emit("end");
    });
  };
  proc.stdout.destroy = function() {
    this.destroyed = true;
    this.emit("close");
  };
  proc.stderr = new EventEmitter();
  proc.stderr.destroyed = false;
  proc.stderr.closed = false;
  proc.stderr.readableEnded = false;
  proc.stderr.resume = function() {
    setImmediate(() => {
      this.readableEnded = true;
      this.emit("end");
    });
  };
  proc.stderr.destroy = function() {
    this.destroyed = true;
    this.emit("close");
  };

  const helper = new EventEmitter();
  helper.pid = pid + 100;
  helper.exitCode = null;
  helper.signalCode = null;
  helper.killed = false;
  helper.stdout = new EventEmitter();
  helper.stdout.readableEnded = false;
  helper.stdout.resume = function() { setImmediate(() => { this.readableEnded = true; this.emit("end"); }); };
  helper.stdout.destroy = function() { this.destroyed = true; this.emit("close"); };
  helper.stderr = new EventEmitter();
  helper.stderr.readableEnded = false;
  helper.stderr.resume = function() { setImmediate(() => { this.readableEnded = true; this.emit("end"); }); };
  helper.stderr.destroy = function() { this.destroyed = true; this.emit("close"); };
  helper.kill = function() {
    this.killed = true;
    this.exitCode = 0;
    this.signalCode = null;
    setImmediate(() => this.emit("exit", 0, null));
  };
  helper.isObservable = function() { return Boolean(this.pid && this.pid > 0); };
  helper.waitForExit = async function(timeoutMs = 3000) {
    if (this.exitCode !== null || this.signalCode !== null) {
      return { exited: true, exitCode: this.exitCode, signalCode: this.signalCode, forcedCleanup: Boolean(this.killed) };
    }
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ exited: false, status: 'UNKNOWN', timedOut: true, forcedCleanup: Boolean(this.killed) });
        }
      }, timeoutMs);
      this.once('exit', (code, signal) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ exited: true, exitCode: code, signalCode: signal, forcedCleanup: Boolean(this.killed) });
        }
      });
    });
  };
  proc.helperProc = helper;

  proc.kill = function(sig) {
    this.killed = true;
    this.exitCode = 0;
    this.signalCode = null;
    if (this.helperProc && !this.helperProc.killed) {
      this.helperProc.killed = true;
      this.helperProc.exitCode = 0;
      this.helperProc.signalCode = null;
      setImmediate(() => this.helperProc.emit("exit", 0, null));
    }
    setImmediate(() => this.emit("exit", 0, null));
  };
  return proc;
}

const mockTakeScreenshot = (screenshotsDir) => async (name) => {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const p = path.join(screenshotsDir, `${name}.png`);
  fs.writeFileSync(p, VALID_PNG_BUF);
  return { name: `${name}.png`, bytes: VALID_PNG_BUF.length, sha256: sha256(VALID_PNG_BUF), leaf: `screenshots/${name}.png` };
};

function createMockClient(procRef, options = {}) {
  let textTurn = 0;
  let userTextTurns = 0;
  let assistantMsgCount = 0;
  let isRunningVal = false;
  let completedLessons = [];
  let exportCount = 0;
  const downloadsDir = options.downloadsDir;

  return {
    async evaluate(expr) {
      if (typeof expr === "function") return expr();
      const s = String(expr).trim();

      // Compound expressions first to avoid substring shadowing
      if (s.includes("emptyInputIgnored") || s.includes("invalidIpcHandled")) {
        return {
          emptyInputIgnored: true,
          invalidIpcHandled: true,
          windowHealthy: true
        };
      }
      if (s.includes("reopenedValues") || (s.includes("providerSelect") && s.includes("ttsModeSelect"))) {
        return { provider: "apple-foundation-models", tts: "kokoro" };
      }
      if (s.includes("hasAttributedPrompt") || s.includes("conversationPaired")) {
        return {
          hasAttributedPrompt: true,
          hasValidReply: true,
          conversationPaired: !options.failStopAttribution
        };
      }

      if (s.includes("window.electronAPI?.quit") || s.includes("window.close()")) {
        if (procRef) {
          procRef.killed = true;
          procRef.exitCode = 0;
          procRef.signalCode = null;
          if (procRef.helperProc) {
            procRef.helperProc.killed = true;
            procRef.helperProc.exitCode = 0;
            procRef.helperProc.signalCode = null;
            if (typeof procRef.helperProc.markExited === 'function') {
              procRef.helperProc.markExited(0, null);
            } else {
              setImmediate(() => procRef.helperProc.emit("exit", 0, null));
            }
          }
          if (procRef.profilePath) {
            const receiptPath = path.join(procRef.profilePath, 'helper-lifecycle-receipt.json');
            try {
              fs.writeFileSync(receiptPath, JSON.stringify({
                version: 1,
                type: "MAIN_HELPER_LIFECYCLE_RECEIPT",
                ownerId: "main-authority",
                terminalReceipt: true,
                status: "exited",
                exited: true,
                reaped: true,
                exitCode: 0,
                signalCode: null
              }));
            } catch {}
          }
          setImmediate(() => procRef.emit("exit", 0, null));
        }
        return true;
      }

      if (s === "document.title") return "Voice Practice Full Acceptance";
      if (s.includes("statusLabel") && s.includes("textContent")) return "Ready";
      if (s.includes("ttsEngineLabel") && s.includes("textContent")) return "Kokoro Local";
      if (s.includes("foundationModelsCapabilities")) return { state: "available" };

      if (s.includes("document.getElementById('settingsModal')?.style.display !== 'none'")) {
        return true;
      }
      if (s.includes("document.getElementById('settingsModal')?.style.display === 'none'")) {
        return true;
      }
      if (s.includes("sel.value = 'apple-foundation-models'") || s.includes("sel.value = 'kokoro'")) {
        return true;
      }
      if (s === "document.getElementById('providerSelect')?.value") return "apple-foundation-models";
      if (s === "document.getElementById('ttsModeSelect')?.value") return "kokoro";
      if (s.includes("testConnResult")) return true;
      if (s.includes("localStorage.getItem('vp_provider')")) {
        if (s.includes("===")) return true;
        return "apple-foundation-models";
      }
      if (s.includes("localStorage.getItem('vp_ttsMode')")) {
        if (s.includes("===")) return true;
        return "kokoro";
      }
      if (s.includes("localStorage.getItem('vp_tts_mode')")) {
        if (s.includes("===")) return false;
        return null;
      }
      if (s.includes("Array.isArray(parsed) && parsed.length > 0")) {
        return true;
      }

      if (s.includes("preStopState") || (s.includes("voiceSessionEpoch") && s.includes("msgCount"))) {
        return { msgCount: assistantMsgCount, epoch: 1, token: 1, turn: null };
      }

      if (s.includes("helperLifecycle") || s.includes("foundationModelsLifecycle")) {
        if (options.failHelperLifecycle) return null;
        const nonce = procRef?.launchNonce || "mock-launch-nonce";
        const secret = procRef?.lifecycleSecret || "mock-secret";
        const receipt = options.helperLifecycleReceipt || {
          version: 1,
          type: "MAIN_HELPER_LIFECYCLE_RECEIPT",
          launchNonce: nonce,
          sessionNonce: nonce,
          ownerId: "main-authority",
          component: "voice-foundation-models",
          helperKind: "foundation-models",
          binaryName: "voice-foundation-models",
          helperPid: (procRef?.helperProc?.pid) || (procRef?.pid ? procRef.pid + 100 : 77001),
          status: "running",
          exited: false,
          reaped: false,
          exitCode: null,
          signalCode: null,
          seq: 1,
          issuedAt: Date.now(),
          authSignature: ""
        };
        if (!receipt.authSignature && secret) {
          receipt.authSignature = computeReceiptSignature(secret, receipt);
        }
        return receipt;
      }

      if (s.includes("expectedUserText") || s.includes("USER_BUBBLE_NOT_YET_APPENDED")) {
        if (options.failLessonDialogue) {
          return { ready: false, reason: 'SIMULATED_LESSON_DIALOGUE_FAILURE' };
        }
        return {
          ready: true,
          replyText: "Hello coach, let us practice this lesson dialogue.",
          replyLength: 50,
          turnOwnerId: "turn-mock",
          verifiedAssistantOwnerId: "turn-mock"
        };
      }
      if (s.includes("lastAssistantText") || s.includes("preDialogueState")) {
        return {
          assistantCount: assistantMsgCount,
          userCount: userTextTurns,
          lastAssistantText: "Previous assistant message",
          messagesCount: assistantMsgCount + userTextTurns
        };
      }

      if (s.includes("messages !== 'undefined'") || s.includes("Array.isArray(messages)")) {
        if (s.includes("validText") || s.includes("turnCheck") || s.includes("turnBound")) {
          return {
            ready: true,
            length: 50,
            validText: true,
            turnBound: true,
            nonError: true,
            messageRecorded: true
          };
        }
        return assistantMsgCount + userTextTurns;
      }

      if (s.includes("#chatBox .chat-msg")) {
        return userTextTurns + assistantMsgCount;
      }
      if (s.includes("document.getElementById('chatBox')?.children.length || 0")) {
        return userTextTurns + assistantMsgCount;
      }
      if (s.includes("turnCheck") || s.includes("validText") || (s.includes("turnBound") && s.includes("nonError"))) {
        return {
          ready: true,
          length: 50,
          validText: true,
          turnBound: true,
          nonError: true,
          messageRecorded: true
        };
      }
      if (s.includes(".chat-msg.assistant .msg-bubble")) {
        if (s.includes("return msgs.length ? msgs[msgs.length - 1]") || s.includes("msgs[msgs.length - 1].textContent")) {
          return "Hello, accepted turn response for full acceptance.";
        }
        if (s.includes("validText") || s.includes("turnBound") || s.includes("turnCheck") || s.includes("ready:")) {
          return {
            ready: true,
            length: 50,
            validText: true,
            turnBound: true,
            nonError: true,
            messageRecorded: true
          };
        }
        if (s.includes(".length")) {
          return assistantMsgCount;
        }
        return "Hello, accepted turn response for full acceptance.";
      }
      if (s.includes(".chat-msg.user")) {
        if (s.includes(".length")) return userTextTurns;
        return "Hi recovery turn!";
      }
      if (s.includes("hasOwner") || s.includes("coachThinking") || (s.includes("inFlight") && s.includes("coachStatus"))) {
        return {
          inFlight: true,
          turnId: "turn-mock-stop",
          coachStatus: "thinking"
        };
      }

      if (s.includes("__ttsPreRef") && s.includes("window.__ttsPreRef =")) {
        return true;
      }
      if (s.includes("preTtsState") || (s.includes("voiceSessionEpoch") && s.includes("voicePlaybackToken") && s.includes("voiceTurnOwner") && s.includes("runtime") && !s.includes("Audio"))) {
        return { epoch: 1, token: 1, turn: null, runtime: null, speechOwner: null };
      }

      if (s.includes("!!document.getElementById('startBtn')")) return true;

      if (s.includes("#coachGrid .coach-choice-item") && s.includes("card.click()")) return true;
      if (s.includes("operationReplaced") || (s.includes("Audio") && s.includes("decodedDuration") && s.includes("speechSettled"))) {
        return {
          audioAvailable: true,
          ctxAvailable: true,
          canPlayWav: true,
          canPlayWebm: true,
          speechSettled: !options.failTtsSettled,
          playbackStarted: true,
          speakReplySuccess: !options.failTtsSettled,
          decodedDurationVerified: true,
          turnEpochBound: !options.failTtsSettled,
          operationReplaced: Boolean(options.ttsOperationReplaced),
          hasTriggeredOp: !options.failTtsNoTrigger
        };
      }

      if (s.includes("#coachGrid .coach-choice-item") && s.includes("cards[1].click()")) return true;
      if (s.includes("currentVoiceId")) return "af_bella";
      if (s.includes("coachHeaderTag")) return "Coach Bella";

      if (s.includes("shadowResultBox")) {
        return {
          ok: true,
          buttonPresent: true,
          boxPresent: true,
          scoringValid: true,
          scoreCalculated: 40
        };
      }

      // Target lesson selection in LESSON row (Addressing F4 & F5)
      if (s.includes("targetInfo") || (s.includes("startSpecificLesson") && s.includes("return { id"))) {
        return { id: "lesson-1", onclickAttr: "startSpecificLesson('lesson-1')" };
      }
      if (s.includes("currentLessonMatched") || (s.includes("currentLessonId") && s.includes("currentLessonId === id"))) {
        return true;
      }
      if (s.includes("targetLessonId") || s.includes("lesson-item") || s.includes("lesson-card") || s.includes("startSpecificLesson")) {
        if (s.includes("getAttribute") || s.includes("lessonId")) return "lesson-1";
        return true;
      }
      if (s.includes("document.getElementById('lessonPracticeBanner')?.style.display !== 'none'")) {
        return true;
      }
      if (s.includes("currentLessonTitle")) return "Lesson 1";
      if (s.includes("document.getElementById('sectionLesson')?.style.display !== 'none'")) {
        return true;
      }

      // RESTORE prompt & confirmation (Addressing F5 & R10 F1)
      if (s.includes("confirmPromptCalled") || s.includes("promptMsg") || s.includes("lessonsBefore")) {
        return {
          confirmPromptCalled: true,
          promptMsg: "確定恢復內建範例課程？目前自訂課程會被取代，請先匯出備份。",
          preserved: !options.failRestoreCancelPreserved
        };
      }
      if (s.includes("defaultLessonsJson") || s.includes("restoreDefaultLessons") || s.includes("testLessonCleared") || s.includes("origConfirm")) {
        completedLessons = [];
        return {
          confirmCalled: true,
          defaultCount: 3,
          countAfter: 3,
          testLessonCleared: true,
          matchesDefault: !options.failRestoreDefaultsMatch,
          progressReset: true
        };
      }

      if (s.includes("completeCurrentLesson")) {
        if (!completedLessons.includes("lesson-1")) completedLessons.push("lesson-1");
        return true;
      }

      if (s.includes("vp_completed_lessons")) {
        if (s.includes("=== null")) {
          return completedLessons.length === 0;
        }
        if (s.includes("Array.isArray(parsed) && parsed.length > 0")) {
          return true;
        }
        return completedLessons.slice();
      }

      if (s.includes("lessonJsonEditor")) {
        return {
          countBefore: 5,
          countAfter: 6,
          successMsgPresent: true,
          errorMsgPresent: true,
          dataPreserved: true
        };
      }

      if (s.includes("restore-backup-reimport.json")) {
        return true;
      }

      if (s.includes("lessonImportFile") && s.includes("lessonImportMode")) {
        return {
          mergeSuccess: true,
          countIncremented: true,
          invalidFileRejected: true,
          dataPreservedOnBadFile: true,
          replaceSuccess: true,
          oversizeRejected: true,
          cancelHandled: true
        };
      }

      if (s.includes("schemaVersion: 1") || s.includes("lessons: list") || s.includes("lessons !== 'undefined' ? lessons")) {
        return JSON.stringify({ schemaVersion: 1, lessons: [{ id: "l1" }, { id: "l2" }] });
      }

      if (s.includes("exportLessonLibrary()")) {
        exportCount++;
        if (options.failExport && exportCount === 1) {
          return true;
        }
        if (options.failSecondExport && exportCount >= 2) {
          return true;
        }
        if (downloadsDir) {
          fs.mkdirSync(downloadsDir, { recursive: true });
          const exportData = { schemaVersion: 1, lessons: [{ id: "l1", title: "Lesson 1" }, { id: "l2", title: "Lesson 2" }] };
          fs.writeFileSync(path.join(downloadsDir, `voice-practice-lessons-export-${Date.now()}-${exportCount}.json`), JSON.stringify(exportData));
        }
        return true;
      }
      if (s.includes("restore-backup-reimport.json") || s.includes("exported-reimport.json") || s.includes("uiReimportSuccess") || s.includes("reimportMsg")) {
        return !options.failUiReimport;
      }

      if (s.includes("isRunningNow")) {
        return {
          isRunning: false,
          audioActive: false,
          coachStatus: "ready",
          epoch: 2,
          token: 2,
          turn: null
        };
      }
      if (s === "typeof isRunning !== 'undefined' ? isRunning : false" || s.includes("typeof isRunning !== 'undefined' ? isRunning : false")) {
        return isRunningVal;
      }
      if (s.includes("voicePlaybackToken") && s.includes("voiceSessionEpoch") && s.includes("return")) {
        return { epoch: 2, token: 3 };
      }
      if (s.includes("currentAudioObj")) {
        return false;
      }

      if (s.includes("vp_r6_marker")) return true;
      if (s.includes("document.readyState")) return true;
      if (s.includes("__stopObserver")) return true;

      throw new Error(`MOCK_UNKNOWN_EXPRESSION:${s.slice(0, 80)}`);
    },

    async clickSelector(sel) {
      const s = String(sel).trim();
      if (s === "button[onclick=\"openSettingsModal()\"]") return true;
      if (s === "button[onclick=\"testApiConnection()\"]") return true;
      if (s === "button[onclick=\"saveSettings()\"]") return true;
      if (s === "button[onclick=\"closeSettingsModal()\"]") return true;
      if (s === "button[onclick=\"sendManualText()\"]") {
        textTurn++;
        userTextTurns++;
        assistantMsgCount++;
        isRunningVal = true;
        return true;
      }
      if (s === "button.coach-select-trigger") return true;
      if (s === "#tabBtnLesson") return true;
      if (s.includes(".lesson-item") || s.includes(".lesson-card") || s.includes("startSpecificLesson")) return true;
      if (s.includes("completeCurrentLesson()") || s.includes("#lessonPracticeBanner button.btn-start")) {
        if (!completedLessons.includes("lesson-1")) completedLessons.push("lesson-1");
        return true;
      }
      if (s === "button[onclick=\"openLessonManager()\"]") return true;
      if (s === "button[onclick=\"closeLessonManager()\"]") return true;
      if (s === "button[onclick=\"exportLessonLibrary()\"]") {
        exportCount++;
        if (options.failExport && exportCount === 1) return true;
        if (options.failSecondExport && exportCount >= 2) return true;
        if (downloadsDir) {
          fs.mkdirSync(downloadsDir, { recursive: true });
          const exportData = { schemaVersion: 1, lessons: [{ id: "l1", title: "Lesson 1" }, { id: "l2", title: "Lesson 2" }] };
          fs.writeFileSync(path.join(downloadsDir, `voice-practice-lessons-export-${Date.now()}-${exportCount}.json`), JSON.stringify(exportData));
        }
        return true;
      }
      if (s === "#tabBtnFree") return true;
      if (s === "button.btn-stop") {
        isRunningVal = false;
        if (assistantMsgCount > 0) assistantMsgCount--;
        return true;
      }

      throw new Error(`MOCK_UNKNOWN_SELECTOR:${s}`);
    },

    async setInputValue(sel, val) {
      if (sel === "#userTextInput") return true;
      throw new Error(`MOCK_UNKNOWN_SELECTOR:${sel}`);
    },

    async send(method, params) {
      return {};
    },

    async quit() {
      if (procRef && !procRef.killed) {
        const receiptPath = procRef.receiptPath || (procRef.profilePath ? path.join(procRef.profilePath, 'helper-lifecycle-receipt.json') : null);
        if (receiptPath) {
          try {
            const secret = procRef.lifecycleSecret || 'mock-secret';
            const receipt = {
              version: 1,
              type: 'MAIN_HELPER_LIFECYCLE_RECEIPT',
              launchNonce: procRef.launchNonce,
              sessionNonce: procRef.launchNonce,
              ownerId: 'main-authority',
              component: 'voice-foundation-models',
              helperKind: 'foundation-models',
              binaryName: 'voice-foundation-models',
              helperPid: procRef.helperProc?.pid || (procRef.pid ? procRef.pid + 100 : 99999),
              status: 'exited',
              exited: true,
              reaped: true,
              exitCode: 0,
              signalCode: null,
              seq: 999,
              issuedAt: Date.now(),
              authSignature: ''
            };
            receipt.authSignature = computeReceiptSignature(secret, receipt);
            const dir = path.dirname(receiptPath);
            const tempPath = path.join(dir, `.receipt.tmp.${crypto.randomBytes(6).toString('hex')}`);
            const fd = fs.openSync(tempPath, 'wx', 0o600);
            fs.writeFileSync(fd, JSON.stringify(receipt, null, 2), 'utf8');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fs.renameSync(tempPath, receiptPath);
          } catch {}
        }
        procRef.killed = true;
        procRef.exitCode = 0;
        procRef.signalCode = null;
        if (procRef.helperProc && !procRef.helperProc.killed) {
          procRef.helperProc.killed = true;
          procRef.helperProc.exitCode = 0;
          procRef.helperProc.signalCode = null;
          if (typeof procRef.helperProc.markExited === 'function') {
            procRef.helperProc.markExited(0, null);
          } else {
            setImmediate(() => procRef.helperProc.emit("exit", 0, null));
          }
        }
        setImmediate(() => procRef.emit("exit", 0, null));
      }
      return true;
    },

    close() {}
  };
}

function createTempEvidenceDir(results, options = {}) {
  const { createEvidencePayload } = require("../../scripts/acceptance-evidence-validator.cjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-evidence-test-"));
  const round = options.round || "R10";
  const codeTestedSha = options.codeTestedSha || CODE_TESTED_SHA;
  const packetCommitSha = options.packetCommitSha || PACKET_SHA;
  const buildSha = options.buildSha !== undefined ? options.buildSha : CODE_TESTED_SHA;

  const appBinaryReceipt = { bytes: 1024, sha256: DUMMY_HEX_64 };
  const asarReceipt = { bytes: 2048, sha256: DUMMY_HEX_64 };
  const helperReceipt = { bytes: 4096, sha256: DUMMY_HEX_64 };

  const payload = createEvidencePayload({
    round,
    codeTestedSha,
    packetCommitSha,
    buildSha: (buildSha && typeof buildSha === "string") ? buildSha : CODE_TESTED_SHA,
    results,
    appBinaryReceipt,
    asarReceipt,
    helperReceipt
  });

  if (buildSha !== undefined) {
    if (buildSha === null) {
      delete payload.artifactsJson.packagedApp.buildSha;
    } else {
      payload.artifactsJson.packagedApp.buildSha = buildSha;
    }
  }

  if (options.mutateArtifacts) {
    options.mutateArtifacts(payload.artifactsJson);
  }
  if (options.mutateSummary) {
    options.mutateSummary(payload.summaryJson);
  }
  if (options.mutateCases) {
    options.mutateCases(payload.casesJson);
  }

  const submissionMd = `# macOS Full Functional Acceptance Report — ${round}\n## Summary\nOverall Status: ${payload.summaryJson.status}\n`;
  const submissionBuf = Buffer.from(submissionMd, "utf8");

  const casesBuf = Buffer.from(JSON.stringify(payload.casesJson, null, 2) + "\n", "utf8");
  const artifactsBuf = Buffer.from(JSON.stringify(payload.artifactsJson, null, 2) + "\n", "utf8");
  const scopeBuf = Buffer.from(JSON.stringify(payload.scopeJson, null, 2) + "\n", "utf8");

  payload.summaryJson.artifacts["cases.json"] = { bytes: casesBuf.length, sha256: sha256(casesBuf) };
  payload.summaryJson.artifacts["artifacts.json"] = { bytes: artifactsBuf.length, sha256: sha256(artifactsBuf) };
  payload.summaryJson.artifacts["scope.json"] = { bytes: scopeBuf.length, sha256: sha256(scopeBuf) };

  fs.writeFileSync(path.join(tmp, "cases.json"), casesBuf);
  fs.writeFileSync(path.join(tmp, "artifacts.json"), artifactsBuf);
  fs.writeFileSync(path.join(tmp, "scope.json"), scopeBuf);
  fs.writeFileSync(path.join(tmp, "summary.json"), JSON.stringify(payload.summaryJson, null, 2) + "\n");
  fs.writeFileSync(path.join(tmp, "submission.md"), submissionBuf);

  return tmp;
}

module.exports = {
  createMockProc,
  createMockClient,
  mockTakeScreenshot,
  createTempEvidenceDir,
  VALID_PNG_BUF,
  DUMMY_HEX_64,
  CODE_TESTED_SHA,
  PACKET_SHA,
  ROUND,
  computeReceiptSignature,
  sha256
};
