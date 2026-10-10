# macOS 按需模型：設定與啟動契約

v0.3.0-beta.1 起 macOS App 使用此模式：App 內含語音 runtime，不含模型；STT／TTS 模型由使用者在設定頁下載。以下介面與 unit tests 不能代替真實下載與打包 App 的驗收。

## 第一階段範圍

- macOS Apple Silicon：frozen runtime、Python／MLX／ONNX 與必要英文 G2P 資料仍在 App；STT／TTS 大型模型分成兩個 managed packs。
- 使用已驗過的模型家族與格式：MLX Whisper（四檔，見 [STT 模型自選](stt-model-choice.md)），以及 Kokoro v1 fp16 ONNX／共享 voices archive。不要求使用者安裝 Python 或 pip。
- 只啟用英文 `en`。模型能力、UI locale、練習語言與 backend code 是不同層級；多語言 metadata 不等新語言已產品驗收。
- 初版原生語音對話仍要求 STT 與 TTS 兩包都就緒。兩包可分別下載，不宣稱 STT-only／TTS-only readiness。缺模型時 App／文字功能仍可使用。
- 安裝完成後完整 Quit＋重開才啟用；不在正在使用的 sidecar 上 hot-swap 模型。
- 移除規則見 [STT 模型自選](stt-model-choice.md)：只有已安裝、而且不是 lease／目前設定／安裝中的模型，`canRemove` 才是 `true`。
- 舊 schemaVersion 1 全 bundled 模式、其他既有 managed ZIP 路徑保留。

## 固定來源與版本

`resources/macos-model-packs.json` 包含三個建置輸入：

1. `modelManifest`：model-manifest v3，穩定 release、raw-file source URL、逐檔 SHA256／bytes、tree digest、授權與 provenance。
2. `capabilities`：語言／backend／format／platform profile，與第一階段 enabled-language policy。
3. `modelBindings`：runtime 使用的 `sttRoot`、`onnxModel`、`onnxVoices` 與確切 raw identity。

模型 release／內容身分獨立於 App version。只有 compiled runtime-only root 綁定的 model manifest digest 能成為 native model authority；capability digest 另外驗證。資料檔不得授權自身，測試 digest／明示 trust overrides 不取得 native 資格。

官方匿名 HTTPS 原檔依固定 Hugging Face revision／GitHub release 來源取得；目錄不保存 signed CDN redirect query，也不讀取使用者登入憑證。下載層只允許已驗證的窄 redirect lanes。Wrapper、模型與 G2P 資料的授權分開看待。

安裝重用原 `ModelManager`／`RuntimeManager`／coordinator，詳見 v3 raw 模型契約。raw identity 是 `{kind:'raw-files',treeDigest}`，不捏造 ZIP archive digest。

## Main 啟動路徑

```text
bounded no-follow manifest reads
→ compiled model-manifest authority
→ capability digest／format／language／role binding validation
→ cached installed-state projection
→ verify bundled runtime-only root
→ 缺模型：不下載、不建立 speech child，繼續開 UI
→ 兩包都 installed：同步取得原 hybrid lease，先登記 owner 才 await work
→ private model snapshots＋runtime root 最後同步驗證
→ 原 nativeRuntime＋hybrid-speech Sidecar
→ kernel no-fork lifetime＋原 client／pipes／generation retirement
```

Runtime 的 executable 留在 App；模型固定在本次 private snapshot。模型的 cache/install 狀態不是 process-tree 終止證明。完整所有權與 source observation 見 hybrid voice assets 及 Darwin no-fork。

## 受限設定介面

- `nativeModelOverview()` → `models:overview`，無參數，只回 cached projection，不因 UI polling 重 hash 大型模型。
- `installNativeModel(modelId)` → 既有 `models:install`；僅接受目錄中 ID，不能傳 URL、path、environment 或任意 command。
- `cancelNativeModelInstallAction(actionId)` → `models:cancel-action`，只帶確切 UUID，不接受 model ID 代替 action ID。

Overview v1：

```text
mode: runtime-only | bundled | managed | unavailable
runtime.state: embedded | unavailable
targetLanguage: en
enabledLanguages: [en]
models[]:
  modelId, name, kind, languages, bytes, license {spdx,url}
  state: missing | installed | active | unavailable
  restartRequired, canRemove
installation: null 或
  actionId, modelId, phase, bytes, total, cancelled, restartRequired, errorCode?
restartRequired
```

不向 renderer 回傳本機模型路徑、generation root、process handles、下載 URL 或 native authority。授權 metadata 以文字顯示，不建立未驗證的外部連結。

## 安裝與取消真相

```text
confirming → downloading → verifying → installed
           ↘ cancelling → cancelled
           ↘ failed
```

- 使用者按安裝後，Main 仍要求原生對話框確認名稱、release、大小與授權；未同意不 fetch。
- 每次 request 都有自己的 action ID、progress callback 與原始 promise。舊 callback／舊取消請求不能改寫或取消同 model ID 的後繼操作。
- `cancelling` 只表示已發出取消；原 stream／transaction 尚未結束時仍禁止第二次安裝。UI 不提早宣稱 cancelled。
- `verifying` 在 raw streams 完成後、inventory／activation commit 前回報，仍可取消。
- Commit 與 cancellation 以既有 atomic metadata 規則判定。若已 commit，仍回 installed／restartRequired，不把真正安裝完成說成 cancelled。
- UI 關閉／重開只撤銷 observer，不自行取消 Main 安裝。重開讀取同一 Main 的 cached 狀態。
- UI 只在有 active action 時每 500 ms 觀察，避免重疊 polling；late import／late reads／舊 view 不得復活 observer。
- Browser／缺少必要 IPC 的平台不載入 desktop-only model panel；不改既有 Browser／iOS 語音處理。

## 驗證界線

來源 gate：`npm test`（macOS 上即 `node scripts/run-mac-tests.mjs`）。

真 App 驗收必須另外記錄：

- 無模型啟動、文字功能與未同意零下載。
- 兩包真官方下載、progress／取消／明確重試，逐檔身分與 metadata。
- 完整 Quit 重開、已安裝模型離線重用，不碰使用者既有 profile／開發 cache。
- 真 packaged App 的 STT → 本機 LLM → TTS，以及冷／暖／端到端時間。
- 原生 lifetime／source proof、退出後無殘留 child 與已安全退休的 private snapshot。
- 缺檔、竄改、錯誤來源與不相容語言／format 拒絕。

合成音訊經真 IPC 的測試，不等於真人麥克風／喇叭的驗證。公開 App 為 ad-hoc 簽章，未經 Developer ID 簽章或公證。
