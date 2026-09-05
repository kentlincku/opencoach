# Install on iOS (TestFlight Beta)

Voice Practice iOS 版本使用原生 SwiftUI 搭配本地 bundled Web UI，由 Swift 原生網路層（`URLSession`）連接區域網路（LAN）模型服務（如 Mac 上的 oMLX 或 Ollama）。

## 系統需求

- iPhone 或 iPad，執行 **iOS 17.0** 或以上版本。
- 欲連接本機模型時，裝置須與模型主機（如 Mac）連上同一個受信任 Wi-Fi / 區域網路。

## 安裝方式

### 方式 A: TestFlight Beta（推薦）
1. 於 iPhone 安裝 Apple 官方 **TestFlight** App。
2. 點擊 Voice Practice TestFlight 公開邀請連結或接受邀請郵件。
3. 點擊「安裝」或「更新」。

### 方式 B: 開發者從原始碼建置
1. 確保已安裝 Xcode 15+ 及最新命令列工具。
2. 於 repository 根目錄執行建置：
   ```bash
   npm ci
   npm run build:icons
   npm run build:web
   ```
3. 開啟 `apps/ios/VoicePractice.xcodeproj`。
4. 選擇你的實機或 iOS 模擬器作為 Target，點擊 **Run**。

## 區域網路模型連線步驟

1. 於 Mac 啟動 oMLX（監聽 LAN 或 `0.0.0.0:8000`）。
2. 在 iPhone 開啟 Voice Practice App。
3. 進入「設定大腦 AI 模型」：
   - API Base URL 輸入 Mac 的區域網路網址，例如 `http://192.168.1.50:8000/v1` 或 `http://my-mac.local:8000/v1`。
4. 系統將會彈出「Voice Practice 想要尋找並連接您區域網路上的裝置」權限提示，請選擇**允許**。
5. 點擊「從端點取得模型」，選擇欲使用的模型後點擊儲存即可開始對話。

## 權限與隱私說明

- **區域網路權限 (`NSLocalNetworkUsageDescription`)**: 僅用於連接您自架於同網域內的本機 LLM，不向公網 HTTP 廣播或掃描無關設備。
- **麥克風權限 (`NSMicrophoneUsageDescription`)**: 僅在使用者主動點擊錄音時取用麥克風聲音，本機語音模型辨識完成後即銷毀暫存，絕不將音訊上傳外部雲端。
- **API Key 安全隔離**: 若設定雲端或受保護 API Key，金鑰透過 iOS Keychain 原生加密儲存，WebView 無法直接讀取。
