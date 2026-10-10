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
4. 在 target **VoicePractice** 的 Signing & Capabilities：
   - Team 選你自己的 Apple ID（免費的 Personal Team 也可以）。
   - Bundle Identifier 改成你自己的唯一值，例如 `com.<你的名字>.opencoach`。原本的 `com.kentlin.voicepractice.ios` 已被註冊，其他帳號不能使用。
5. 用傳輸線接上 iPhone，在 Xcode 上方選擇該裝置，執行 **Run**。
6. 第一次安裝時，iPhone 需要：
   - 開啟「設定 → 隱私權與安全性 → 開發者模式」，依提示重新開機。
   - 到「設定 → 一般 → VPN 與裝置管理」信任你的開發者 App。
7. 使用免費 Personal Team 簽的 App 約 7 天後失效，到時用 Xcode 再 Run 一次即可；付費 Apple Developer Program 帳號則為 1 年。

也可以選 iOS 模擬器執行，但模擬器不能代替實機麥克風與揚聲器的驗證。

### TestFlight／App Store

目前沒有 TestFlight 邀請，也沒有上架 App Store；v0.3.0-beta.1 的 iOS 只提供原始碼，請照上面步驟自行建置。

## 區域網路模型連線

1. 在模型主機啟動 OpenAI-compatible 服務，設定僅供受信任區網存取的監聽位址與防火牆。
2. 在 iPhone 開啟 OpenCoach，進入右上角「設定」。
3. 選擇 OpenAI-compatible API、自訂端點；API Base URL 輸入模型主機的區域網路位址，例如 `http://192.168.1.50:8000/v1`。`localhost`／`127.0.0.1` 指的是 iPhone 自己，不是 Mac。
4. 若系統顯示區域網路存取權限提示，依需要允許。
5. 取得模型清單或輸入有效模型名稱，測試連線並儲存。

HTTP 不加密：API Key 與對話可能以明文在區網傳輸，只應在受信任 LAN／VPN 使用；公網 HTTP 由原生安全政策拒絕。雲端端點請使用 HTTPS。

## 原生英文朗讀與固定畫面比例

iOS App 的頁面固定為 1 倍；雙指縮放與輸入框聚焦不應放大頁面。iOS 輔助使用的螢幕縮放仍由系統管理。

每位教練都有自己的聲音，預設依教練介紹的性別與口音挑選（例如 Heart → Samantha、Nicole → Moira、Adam → Daniel）。在「教練」頁編輯教練，可以改聲音、語速、音高、名字、介紹和說話風格，也可以按「恢復預設」。朗讀由 `AVSpeechSynthesizer` 在裝置上執行，沒有雲端語音備援。自動選擇時會避開 Eloquence 與趣味聲音，優先選 premium、enhanced 的自然人聲。

如果清單裡只有標準聲音，請在教練的聲音欄位點「＋ 新增聲音」：第一次點會顯示步驟，第二次點會打開 iPhone 設定。到「輔助使用 → 朗讀內容 → 聲音 → 英文」下載增強或高品質聲音後，回到 App 即可選用。App 不能代替系統安裝聲音。

停止、離開頁面、切到背景或音訊中斷會取消目前朗讀；試聽會先停止進行中的對話。首次起播超過 10 秒會結束等待並顯示恢復提示。技術契約見 [iOS native speech bridge](ios-native-speech-bridge.md)。

## 權限、隱私與驗證界線

- **區域網路權限**（`NSLocalNetworkUsageDescription`）：用於使用者指定的模型端點，不掃描無關設備。
- **麥克風與語音辨識權限**：只在你主動開始錄音（對話或跟讀）時取用。辨識使用 Apple Speech，並強制在裝置上執行，錄音不會上傳。iOS App 不內含也不下載瀏覽器版 Whisper／Kokoro 模型。
- **API Key**：原生 provider 連線透過 Keychain 儲存，WebView 不提供讀回已儲存明文金鑰的介面。
- 內建 UI 可離線開啟，不等於雲端 AI、語音辨識或首次模型下載可離線使用。
- Node 契約測試不等於 iOS 編譯、實機音訊或人工聽感驗收。Xcode 的實機 Foundation Models 兩輪推論測試在模型不可用時會 skip；模擬器也不能替代實機模型／揚聲器驗證。
