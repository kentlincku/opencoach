# iOS Physical Device E2E Verification SOP

本文件定義 iPhone / iPad 在受信任區域網路（LAN）環境下連接 Mac 本機模型（oMLX / Ollama）與語音端到端驗收標準。

## 1. 測試前環境準備

1. **Mac (模型端)**:
   - 確保 oMLX 或 Ollama 在 Mac 運行，並受控監聽區域網路介面（如 `http://192.168.x.x:8000/v1` 或 `http://<hostname>.local:8000/v1`）。
   - 防火牆配置只允許內部 LAN 子網連線。
2. **iPhone / iPad (客戶端)**:
   - 與 Mac 連接至相同受信任 Wi-Fi 網路（禁止公用無加密 Wi-Fi）。
   - iOS 17+ 裝置，透過 Xcode 或 TestFlight 安裝 Voice Practice App。

## 2. 驗收步驟與檢驗點

### 步驟 1: Local Network 權限提示與連線
- 首次開啟 App 並於設定輸入 Mac LAN URL（如 `http://192.168.1.50:8000/v1`）。
- **預期**: iOS 系統彈出「"Voice Practice"想要尋找並連接您區域網路上的裝置」授權對話框（`NSLocalNetworkUsageDescription`）。
- **Allow**: 點擊允許，點擊「從端點取得模型」，應成功回傳模型清單。
- **Deny 測試**: 在「設定」>「Voice Practice」關閉區域網路權限，再次測試連線。
  - **預期**: 網路請求立即阻擋，UI 顯示可操作的系統設定引導，不崩潰、無未授權重試。

### 步驟 2: 麥克風錄音與本機 STT
- 進入主聊天介面，點擊錄音按鈕。
- **預期**: iOS 系統彈出麥克風權限對話框（`NSMicrophoneUsageDescription`）。
- 錄製一段固定英文語音（如 "Hello, how are you today?"）。
- **預期**: 本機 Browser Whisper 完成轉錄，音訊不傳送至外部伺服器。

### 步驟 3: 原生 URLSession LAN LLM 推論
- STT 完成後自動向 LAN oMLX 送出對話請求。
- **預期**:
  - 原生 `URLSession` 直連 Mac LAN 端點，不依賴 Safari CORS 或 LNA。
  - 收到串流/完整 LLM 回覆文字。
  - 逾時（15 秒）或模型伺服器停止時，回傳清楚的錯誤提示，無未捕捉例外。

### 步驟 4: 本機 TTS 播放與狀態重設
- LLM 回答完成後，系統朗讀 AI 教練語音（使用確認為本機的 iOS System Voice）。
- **預期**:
  - 語音播放期間聆聽按鈕處於暫停/不可觸發狀態。
  - 語音播放結束後，按鈕恢復就緒並等待使用者下一輪發話。
  - 按下「停止」能即時打斷當前播放與排隊中任務。

### 步驟 5: 生命週期與安全性檢查
- **前景/背景切換**: 聊天中途縮小至背景再回到 App，連線狀態正常恢復。
- **機密隔離**: 使用 Instruments Network 模板確認 API Key（若有設定）未寫入日誌，且無未宣告的第三方追蹤或外部雲端流量。

## 3. 實機測試結果記錄格式

在實機完成測試後，依[公開測試規範](README.md)提交去敏驗證摘要，原始裝置log保存在受控儲存空間。摘要至少包含：
- Tested SHA (40 字元)
- 裝置型號與 iOS 版本
- Mac 型號與 oMLX / 模型名稱
- 測試結果（Pass / Fail）及具體數據（延遲、WER、RAM）
