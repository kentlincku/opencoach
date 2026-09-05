# Windows R6 產品完整性矩陣

> **Integration 狀態：** `INTEGRATED_CODE_LINUX_CONTRACT_PASS_WINDOWS_RERUN_REQUIRED`
>
> 本矩陣描述 `feat/product-integration-r1` 的整合後產品面。Windows R6來源branch的既有證據不自動轉移到新的integration SHA；packaging、live local LLM、DPAPI、麥克風、喇叭與登入都必須在固定integration SHA重新執行。

## 狀態模型

- `LINUX_CONTRACT_PASS`：只代表Linux上可執行的靜態、unit或contract test通過。
- `PRIOR_FIXED_SHA_EVIDENCE`：來源branch曾有固定SHA證據，但不能當成目前integration SHA的PASS。
- `MANUAL_PROVIDER_LOGIN_NOT_RUN`：需要真實API Key或provider帳號，尚未人工驗證。
- `MANUAL_HARDWARE_NOT_RUN`：需要實體麥克風或喇叭，尚未驗證。
- `UNAVAILABLE_ACCURATELY_DISABLED`：該平台沒有受信任adapter，UI必須隱藏或停用。
- `NOT_RUN:<reason>`：目前integration SHA尚未執行該gate。

## 產品功能項目

| ID | 類別 | 功能 | UI／介面 | Integration狀態 | 驗證邊界 |
|---|---|---|---|---|---|
| F-01 | App Shell | 主視窗與單一實例 | Electron lifecycle | `LINUX_CONTRACT_PASS` | Windows packaged focus仍須重跑 |
| F-02 | App Shell | 自由對話／關卡分頁 | `#tabBtnFree`, `#tabBtnLesson` | `LINUX_CONTRACT_PASS` | 可見UI需Windows driver重跑 |
| F-03 | App Shell | 教練角色選擇 | `#coachCard` | `LINUX_CONTRACT_PASS` | Windows可見操作未跑 |
| F-04 | Offline | 同源PWA資產 | `#offlineStatus` | `LINUX_CONTRACT_PASS` | Packaged offline restart未跑 |
| F-05 | Status | 連線狀態徽章 | `#headerConnBadge` | `LINUX_CONTRACT_PASS` | Windows可見狀態未跑 |
| F-06 | Local LLM | llama.cpp loopback | `127.0.0.1:8080/v1` | `NOT_RUN: integration SHA Windows live rerun required` | 來源branch live evidence不轉移 |
| F-07 | Local LLM | Ollama loopback | `127.0.0.1:11434/v1` | `LINUX_CONTRACT_PASS` | 只驗固定路由與零credential；服務live未跑 |
| F-08 | Local LLM | LM Studio loopback | `127.0.0.1:1234/v1` | `LINUX_CONTRACT_PASS` | 只驗固定路由與零credential；服務live未跑 |
| F-09 | Model | 手動模型切換 | `#toggleManualModelBtn`, `#apiModel` | `LINUX_CONTRACT_PASS` | Windows可見操作未跑 |
| F-10 | Model | 模型探索race防護 | `fetchModelsFromProvider()` | `LINUX_CONTRACT_PASS` | Windows live endpoint未跑 |
| F-11 | Cloud API | OpenAI／Gemini API Key | `#directApiPreset`, `#apiKey` | `MANUAL_PROVIDER_LOGIN_NOT_RUN` | API Key與訂閱權限分離；不得在聊天或log提供credential |
| F-12 | Subscription | ChatGPT／Codex | `#subscriptionAuthGroup` | `MANUAL_PROVIDER_LOGIN_NOT_RUN` | 僅在Main broker具產品client registration時啟用；Renderer不接token |
| F-13 | Subscription | Grok／SuperGrok | `#subscriptionAuthGroup` | `MANUAL_PROVIDER_LOGIN_NOT_RUN` | 僅在Main broker具核准client ID/scope時啟用；Renderer不接token |
| F-13a | Unsupported Auth | retired Google browser account login、Claude/Copilot subscription | 無UI入口 | `UNAVAILABLE_ACCURATELY_DISABLED` | 不得建立generic bridge或模擬消費者網站登入 |
| F-14 | Platform-local LLM | Apple Foundation Models | iOS typed bridge only | `UNAVAILABLE_ACCURATELY_DISABLED` | Windows/Browser/Android不得顯示或呼叫 |
| F-15a | Lessons | 內建7大關卡檢視與選擇 | `#lessonListContainer` | `LINUX_CONTRACT_PASS` | Windows可見操作未跑 |
| F-15 | Lessons | 課程JSON編輯 | `#lessonJsonEditor` | `LINUX_CONTRACT_PASS` | Windows file picker round-trip未跑 |
| F-16 | Lessons | Merge／Replace匯入與匯出 | `#lessonImportFile` | `LINUX_CONTRACT_PASS` | Windows packaged file UI未跑 |
| F-17a | Lessons | 恢復範例課程 | `restoreDefaultLessons()` | `LINUX_CONTRACT_PASS` | Windows可見操作未跑 |
| F-17 | Progress | 關卡進度 | `completeCurrentLesson()` | `LINUX_CONTRACT_PASS` | Windows restart persistence未跑 |
| F-18 | Conversation | 文字輸入 | `#userTextInput`, `sendManualText()` | `LINUX_CONTRACT_PASS` | Windows live reply未跑 |
| F-19 | Shadowing | 文字比對評分 | `startShadowing()`, `#shadowResultBox` | `LINUX_CONTRACT_PASS` | 實體語音不在此PASS內 |
| F-20 | Native STT | faster-whisper runtime | typed Electron IPC | `NOT_RUN: Windows package and model artifacts required` | unpublished manifest必須fail closed |
| F-21 | Native TTS | Kokoro ONNX CPU/DirectML | typed Electron IPC | `NOT_RUN: Windows package and model artifacts required` | 完整fileset、pre-spawn revalidation與實體播放待驗 |
| F-22 | Hardware | 麥克風錄音 | `#startBtn` | `MANUAL_HARDWARE_NOT_RUN` | 需實體Windows麥克風 |
| F-23 | Hardware | 喇叭播放 | TTS playback | `MANUAL_HARDWARE_NOT_RUN` | 需實體Windows喇叭 |
| F-24 | Packaging | NSIS／Portable、canonical dist | R6 PowerShell verifier | `NOT_RUN: Windows runner required` | 必須綁定clean integration SHA與artifact hash |
| F-25 | Security | DPAPI live smoke | safeStorage | `NOT_RUN: Windows runner required` | Linux mock contract不能冒充DPAPI live PASS |

## Acceptance規則

1. 目前只可宣稱整合程式碼的Linux contract結果，不可宣稱Windows R6產品完成。
2. Windows執行者必須從clean、固定integration `CODE_SHA`建置，保存raw log、artifact SHA-256與明確exit code。
3. `runtime-manifest.json`與`model-manifest.json`若仍為`unpublished`，native voice必須準確disabled；不得借用既有cache或下載旗標繞過。
4. ChatGPT/Codex與Grok/SuperGrok是唯一Desktop subscription adapters。Browser、iOS與Android不得取得refresh token。
5. 所有真實登入、付費chat、麥克風、喇叭、簽章與跨版本升級在證據完成前維持`NOT_RUN`。
