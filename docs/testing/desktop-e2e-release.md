# 桌面 E2E、封裝與 Release 驗證 SOP

## 適用範圍

本 SOP 涵蓋 Task 5–10：平台 setup、CI、依賴鎖定、Electron 安裝包、真實端到端流程與 release。現在尚無 `.dmg`、`.exe`／NSIS 或 AppImage；Packaging 區段是未來 artifact 的 release gate，不代表已完成。

## 1. Setup script 驗證（Task 5）

每個平台由乾淨 clone 開始：

- macOS：`scripts/setup-macos.sh`
- Windows：`scripts/setup-windows.ps1`（待建立）
- Linux：`scripts/setup-linux.sh`（待建立）

Pass 條件：

- 建立正確的 Python 3.11 `.venv`。
- 安裝 Node dependencies 與平台相容 Python dependencies。
- Windows 不安裝 MLX；macOS 依 `uname -m` 區分 Apple Silicon／Intel。
- Script 可重複執行，不刪除模型 cache 或使用者資料。
- Linux 缺系統 package 時只輸出 distro-specific 建議，不自動 `sudo`。
- 完成後輸出正確啟動命令。

## 2. Cross-platform CI（Task 6）

矩陣：`ubuntu-latest`、`windows-latest`、`macos-14`，固定 Node 與 Python 3.11。

一般 CI 只執行：

```text
npm ci
fake sidecar contracts
Python unit tests
Node adapter／sidecar tests
Node syntax checks
path／process／temp／MIME security tests
```

Pass：三平台不需要 secrets、不下載大型模型且全綠。真實模型 smoke 使用手動 workflow，不阻擋一般 PR，也不得冒充效能證據。

## 3. 可重現依賴（Task 7）

- `package-lock.json` 與 `uv.lock` 必須隨依賴更新一起 review。
- 以空白 cache／乾淨 clone 做 clean-room install。
- 記錄 lockfile hash、安裝命令及實際 package versions。
- 同一 commit 在同平台重建應得到相同主要版本與 backend selection。

## 4. Runtime artifact（Task 8）

每個 per-platform Runtime artifact 必須有：

- versioned manifest
- OS／arch
- Python/runtime version
- file size
- SHA-256
- HTTPS source
- timeout
- atomic install
- rollback target

測試案例：

1. 正常下載、checksum 通過、原子安裝。
2. 網路中斷，不留下「看似完成」的 partial runtime。
3. SHA-256 不符，拒絕執行且不覆蓋舊版。
4. 磁碟不足，顯示明確錯誤並保留舊版。
5. 新版 runtime 啟動失敗，自動 rollback。
6. Runtime 不存在／下載失敗，App 仍進入 Browser／Cloud fallback。
7. Manifest／下載 URL 不接受 renderer 任意輸入。

## 5. 安裝包驗證

### macOS DMG／App

- 在乾淨測試帳號安裝。
- 驗證 `.app` 可啟動、hardened runtime、entitlements。
- 正式發佈版驗證 Developer ID signature 與 notarization：

```bash
codesign --verify --deep --strict --verbose=2 "Voice Practice Unified.app"
spctl --assess --type execute --verbose=4 "Voice Practice Unified.app"
```

- Apple Silicon 與 Intel artifact／universal 策略必須與 manifest 一致。
- 拖入 Applications、首次啟動、重新啟動、移除都要測試。

### Windows NSIS／EXE

- 在乾淨 Windows 10 與 11 帳號安裝。
- 驗證安裝路徑、Start Menu、重新啟動、Repair／Upgrade／Uninstall。
- 正式版驗證 Authenticode signature；SmartScreen 結果記錄但不繞過安全控制。
- 非管理員安裝與路徑含空白／非 ASCII 使用者名稱至少各測一次。

### Linux AppImage

- 驗證至少一個 Ubuntu LTS 實機／VM。
- 測試 executable bit、啟動、桌面整合選項、缺 FUSE 時的清楚提示。
- 驗證 sandbox、音訊裝置與 temp 目錄行為。

## 6. 真實桌面 E2E（Task 9）

每個支援平台執行：

```text
啟動 App
→ runtime.health
→ 錄製 10 秒音訊
→ native STT
→ 選定 LLM Provider 並取得回覆
→ native/system TTS
→ 播放
→ 再執行第二輪
```

Pass：

- Capability 顯示與實際 engine 一致。
- STT transcript 非空，暫存檔在成功與錯誤後都刪除。
- 第二輪 sidecar PID 不變；另以 benchmark load counter 或去敏 instrumentation 證明 backend/model `loadCount=1`，不能只靠同 PID 推論模型已重用。
- TTS 可解碼及播放。
- Production UI、preload與Main Process只允許ChatGPT/Codex與Grok/SuperGrok兩個typed subscription路徑；無Voice Practice-owned registration時必須disabled。Hermes、CLI identity與generic consumer-subscription bridge均不得存在。
- Browser 模式的直接 API key 仍由 renderer 使用並存於 `vp_provider_keys` localStorage；只應在可信裝置使用。Electron Desktop 的直接 API key 必須透過 write-only IPC 存入作業系統 `safeStorage`，不得回填 renderer；遷移成功或失敗後都不得保留 renderer 明文。兩種模式的測試與風險不可混寫。
- Native backend 缺少時仍可打字、system TTS 與切換已設定的 Cloud Provider。

## 7. Cancellation／Race

逐一在 STT、LLM、TTS pending 時按 Stop：

- 晚到結果不得更新 chat、coach、status 或播放器。
- Native late reject 不得啟動 Cloud fallback。
- 不得在 Stop 後上傳音訊。
- 新一輪 request 不受舊 request 影響。

至少重複 10 次快速 Start／Stop；任何一次 race 即 Fail。

## 8. 安全驗證

- Renderer：`contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`。
- Preload 只暴露白名單 API，不暴露 `require`、任意 IPC、filesystem、child process 或 credential。
- 分開驗證credential邊界：Browser direct API key存於renderer/localStorage，必須列明風險；Electron Desktop direct API key只經write-only IPC進入`safeStorage`，Renderer不得讀回或保留。所有cloud account OAuth入口必須不存在。
- 非 main frame／非受信 `file://` sender 無法呼叫 privileged IPC。
- 遠端 script request 被阻擋。
- 外部導航不能取代主視窗，只能由系統瀏覽器開啟允許的 HTTP(S) link。
- 以 `<img src=x onerror=alert(1)>` 測試 chat、STT、模型回覆、錯誤、shadowing 與 model list；不得建立可執行元素。
- 超大 audio、錯誤 MIME、路徑逃逸、symlink escape、非法 JSON 型別均 fail closed。
- Sidecar stdout 只包含 JSONL；預設 stderr 不含 traceback、credential 或私人路徑。

## 9. Failure／Recovery

逐一模擬：

- Python executable 不存在。
- Sidecar startup timeout。
- Sidecar 在 request 中退出。
- 模型／ONNX voices 缺失。
- 網路斷線。
- 磁碟不足。
- Runtime upgrade checksum 失敗。

Pass：App 不崩潰、不遺留 pending UI、不遺留私人音訊；顯示可理解的 degraded 狀態並保留 fallback／rollback。

## 10. Release Gate

GitHub 的 `release-signing` Environment 必須在遠端設定 required reviewers、禁止 self-review，並將 deployment branch/tag policy 限制為受保護的 `v0.2.0-beta.*` release tags。Workflow 檔案只接受該 tag trigger；若 Environment 保護未設定或 signing secrets 缺失，不得執行正式發佈。

Release 前必須附：

- commit/tag SHA
- CI URLs
- 各平台 evidence template
- artifact filename、size、SHA-256
- signature/notarization 結果
- 支援矩陣：Supported／Beta／Fallback-only
- 已知問題與 rollback 方法
- dependency／license review
- credential／secret scan

任何平台缺少真實 G1–G3 證據時，不得標為 Supported。Release reviewer 必須不是同一位實作者。
