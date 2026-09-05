# Windows Desktop Lite Provider Routing Smoke Test SOP

## 目的

在Windows 11 x64驗證Electron Main Process Provider Broker安全連接同機本地模型。支援固定loopback profiles：

- oMLX：`http://127.0.0.1:8000/v1`
- Ollama：`http://127.0.0.1:11434/v1`
- llama.cpp：`http://127.0.0.1:8080/v1`
- LM Studio：`http://127.0.0.1:1234/v1`

## 安全不變量

1. Electron Renderer不直接fetch本地provider；模型探索與對話必須經preload `providerOperation`進入Main Process Broker。
2. Desktop端只接受上述固定profile；公開IP、LAN IP、其他port、userinfo、query與fragment均fail closed。
3. Local providers為`secret: false`，不得讀取、儲存或發送API key／Bearer token。
4. Request及response上限均為1 MB；連線逾時15秒，redirect拒絕。
5. Raw evidence不得包含prompt、response content、username或private path。

## 目前Windows llama.cpp服務

使用者自行管理`llama serve`程序：

```text
Base URL: http://127.0.0.1:8080/v1
Model alias: ornith-9b
Authentication: none
Binding: loopback only
```

GGUF路徑、GPU offload、thread數及96K context屬該工作站硬體調校，不是Voice Practice產品預設。Executor不得自行下載模型、變更模型檔或啟停server。

Voice Practice設定：

```text
Connection: OpenAI-compatible API
Base URL: http://127.0.0.1:8080/v1
API Key: 留空
Model: 由「取得模型」選取ornith-9b，或手動填ornith-9b
```

## 自動化contract tests

```powershell
node --test `
  tests/provider-broker.test.cjs `
  tests/provider-settings.test.cjs `
  tests/windows-provider-routing.test.cjs `
  tests/windows-credential-contract.test.cjs
```

這只屬contract evidence，不能取代live E2E。

## Live ProviderBroker驗證

在使用者已啟動服務後執行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/verify-windows-local-providers.ps1
```

llama.cpp必須出現：

```text
LLAMACPP_LIVE_MODELS_OK:ornith-9b
LLAMACPP_LIVE_CHAT_1_OK
LLAMACPP_LIVE_CHAT_2_OK
LOCAL_PROVIDER_CREDENTIAL_READS=0
```

Verifier必須透過產品`ProviderBroker`呼叫真實`/v1/models`與兩次`/v1/chat/completions`。若endpoint沒有回傳`ornith-9b`，或任一chat失敗，exit code必須非0。完整、未改寫的PowerShell console transcript及最後exit code必須tee到單一raw log；分開撰寫的provider摘要不能替代raw transcript。

Ollama或LM Studio未啟動時可標`NOT_RUN`；不得用unit-test輸出代替live結果。

## UI smoke

1. 啟動Electron App。
2. 設定上述Base URL，API Key留空。
3. 點擊「取得模型」，確認包含`ornith-9b`。
4. 發送兩次英文練習訊息並取得非空回覆。
5. DevTools Network不得出現Renderer直接連向port 8080的請求。
6. 關閉llama.cpp後再次操作，UI應顯示連線失敗且不當機。

## Evidence

記錄fixed code SHA、Windows版本、Node／Electron版本、exact commands、exit codes與marker。不得記錄prompt全文、模型回覆、使用者名稱、GGUF絕對路徑或其他私人資料。
