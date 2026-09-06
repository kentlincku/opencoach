# 在 iOS 安裝 OpenCoach

OpenCoach iOS 使用原生 SwiftUI 搭配內建 Web UI，由 Swift 原生網路層（`URLSession`）連接 OpenAI-compatible API，包括受信任區域網路中的 oMLX 或 Ollama。原生英文朗讀與 Apple Intelligence 是不同功能；使用朗讀不需要 Apple Intelligence。

## 系統需求

- iPhone 或 iPad，執行 **iOS 17.0** 或以上版本。
- 連接區網模型時，裝置須與模型主機連上同一個受信任 Wi-Fi／區域網路。
- Apple Intelligence provider 另需支援 Apple Intelligence 的裝置、iOS 26+、已啟用 Apple Intelligence、系統模型就緒及支援的語系。App 會再次檢查 availability；不可用時不會自動改送其他 provider。

## 安裝方式

### 從公開原始碼建置

1. 在 Mac 安裝 Xcode 與對應 iOS SDK。要編入 Foundation Models 支援，需包含 FoundationModels framework 的 SDK（Xcode 26+）；較舊 SDK 的條件編譯路徑不提供該模型。
2. 在 [OpenCoach 公開 repository](https://github.com/kentlincku/opencoach) 根目錄準備 Web 資源：
   ```bash
   npm ci
   npm run build:icons
   npm run build:web
   ```
3. 開啟 `apps/ios/VoicePractice.xcodeproj`。專案與 scheme 仍使用內部名稱 `VoicePractice`。
4. 在 Signing & Capabilities 選擇自己的開發團隊；實機建置需要有效簽章與裝置授權。
5. 選擇實機或 iOS 模擬器，執行 **Run**。

### TestFlight（有提供邀請時）

本文件不保證已有可用的公開 TestFlight 邀請或已上架版本。若維護者提供有效邀請，可安裝 Apple TestFlight App，接受邀請後安裝／更新；否則請使用原始碼建置方式。

## 區域網路模型連線

1. 在模型主機啟動 OpenAI-compatible 服務，設定僅供受信任區網存取的監聽位址與防火牆。
2. 在 iPhone 開啟 OpenCoach，進入右上角「設定」。
3. 選擇 OpenAI-compatible API、自訂端點；API Base URL 輸入模型主機的區域網路位址，例如 `http://192.168.1.50:8000/v1`。`localhost`／`127.0.0.1` 指的是 iPhone 自己，不是 Mac。
4. 若系統顯示區域網路存取權限提示，依需要允許。
5. 取得模型清單或輸入有效模型名稱，測試連線並儲存。

HTTP 不加密：API Key 與對話可能以明文在區網傳輸，只應在受信任 LAN／VPN 使用；公網 HTTP 由原生安全政策拒絕。雲端端點請使用 HTTPS。

## 原生英文朗讀與固定畫面比例

iOS App 的頁面固定為 1 倍；雙指縮放與輸入框聚焦不應放大頁面。iOS 輔助使用的螢幕縮放仍由系統管理。

在「設定」的語音區塊可選擇已安裝的英文聲音、朗讀速度，並試聽或停止。自動模式優先選擇 premium，其次 enhanced，最後 standard；同品質優先使用美式英文。教練角色與朗讀聲音分別設定。朗讀由 `AVSpeechSynthesizer` 在裝置執行，沒有語音雲端回退。

若清單只有標準聲音，請到 iPhone「設定」搜尋「朗讀內容」，下載英文增強或高品質聲音，再重新開啟 App 設定。App 不會代替系統設定安裝聲音；可用名稱與品質以裝置回報為準。

停止、離開頁面、切到背景或音訊中斷會取消目前朗讀；試聽會先停止進行中的對話。首次起播超過 10 秒會結束等待並顯示恢復提示。技術契約見 [iOS native speech bridge](ios-native-speech-bridge.md)。

## 權限、隱私與驗證界線

- **區域網路權限**（`NSLocalNetworkUsageDescription`）：用於使用者指定的模型端點，不掃描無關設備。
- **麥克風權限**（`NSMicrophoneUsageDescription`）：僅在使用者主動開始錄音時取用。這次 native speech bridge 只新增 **TTS 朗讀**，並未新增原生 STT；錄音／辨識仍走既有 Web runtime，其模型下載、快取、WKWebView 相容性與離線可用性需另外驗證。
- **API Key**：原生 provider 連線透過 Keychain 儲存，WebView 不提供讀回已儲存明文金鑰的介面。
- 內建 UI 可離線開啟，不等於雲端 AI、語音辨識或首次模型下載可離線使用。
- Node 契約測試不等於 iOS 編譯、實機音訊或人工聽感驗收。Xcode 的實機 Foundation Models 兩輪推論測試在模型不可用時會 skip；模擬器也不能替代實機模型／揚聲器驗證。
