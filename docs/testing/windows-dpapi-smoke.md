# Windows DPAPI 憑證隔離 Smoke Test SOP

## 目的

在 Windows 11 x64 環境驗證 Electron `safeStorage` (Windows DPAPI `CryptProtectData` / `CryptUnprotectData`) 之憑證加密保存、單一使用者隔離及磁碟零明文不變量。

## 核心安全不變量 (Security Invariants)

1. **零明文持久化:** 任何雲端 API Key (OpenAI, Claude, Gemini, Groq, DeepSeek) 在寫入磁碟時，必須經過 Windows DPAPI 加密，以 Base64 ciphertext 形式存放於 JSON 檔案中；明文絕對不得存於磁碟、log 或 localStorage。
2. **本機模型免密原則:** 本機 Provider (`ollama`, `lmstudio`, `omlx`) 禁止寫入或讀取憑證存放庫；`CredentialStore` 白名單直接排除本機 Provider。
3. **Fail-Closed 原則:** 若系統 DPAPI 加密不可用 (`isEncryptionAvailable() === false`)，所有憑證儲存與讀取必須立即拋出錯誤 (`SAFE_STORAGE_UNAVAILABLE`)，絕不降級為明文儲存。
4. **原子寫入 (Atomic Write):** 寫入時先以隨機檔名建立 `.tmp` 暫存檔，寫入完成後透過原子性重新命名 (`rename`) 覆蓋，避免寫入中斷導致檔案損毀。
5. **使用者級別隔離 (User Isolation):** DPAPI 密鑰由 Windows 目前登入使用者的憑據產生；不同 Windows 帳號無法解密其他使用者的憑證檔案。

## 驗證流程

### 1. 自動化測試

執行專屬 DPAPI 憑證合約測試：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-windows-credential-store.ps1
```

預期：全部通過，確認 schema version 1、暫存檔原子替換、毀損檔案隔離與免密 Provider 限制。

### 2. 磁碟實測與去敏檢查

1. 啟動應用程式並設定一組測試用雲端 API Key (例如 OpenAI)。
2. 檢查 `%APPDATA%\Voice Practice\provider-credentials\openai.json`：
   ```powershell
   $content = Get-Content "$env:APPDATA\Voice Practice\provider-credentials\openai.json" | ConvertFrom-Json
   $content.version # 應為 1
   $content.ciphertext # 應為 Base64 字串，不包含原始 key 明文
   ```
3. 確認 `%APPDATA%\Voice Practice` 下所有 log 與 Local Storage 均未出現該測試 key。
4. 於應用程式清除該憑證，確認對應之 `.json` 檔案被完全刪除。
