# Windows R6 人工Provider驗收清單

> 所有項目目前均為 `MANUAL_PROVIDER_LOGIN_NOT_RUN`。不得把Linux fixture、mock DPAPI或來源branch證據當成目前integration SHA的真實登入PASS。

## 安全不變量

1. 不在聊天、terminal、截圖、raw log或Git中貼出API key、access token、refresh token、device code或cookie。
2. API key只由Electron Main Process透過Windows `safeStorage`／DPAPI保存；Renderer只能取得`hasCredential`狀態。
3. Subscription refresh token只存在Main Process encrypted store；Renderer僅接收status、verification URL、user code、models與normalized reply。
4. 每條測試使用專用測試帳號／低額度key；測後logout或clear credential。
5. 401、403、429、timeout、cancel與restart不得洩露response body、token或stack。
6. 未配置產品client registration時，ChatGPT/Codex與Grok/SuperGrok選項必須disabled並說明原因。

## 支援矩陣

| Provider | Windows Desktop方式 | 目前狀態 |
|---|---|---|
| OpenAI-compatible Direct API | 固定／受信任profile＋API key | `MANUAL_PROVIDER_LOGIN_NOT_RUN` |
| Gemini Direct API | 固定官方endpoint＋API key | `MANUAL_PROVIDER_LOGIN_NOT_RUN` |
| ChatGPT／Codex | typed Main Process subscription broker | `MANUAL_PROVIDER_LOGIN_NOT_RUN`；沒有產品client registration時disabled |
| Grok／SuperGrok | typed Main Process subscription broker | `MANUAL_PROVIDER_LOGIN_NOT_RUN`；沒有核准client ID/scope時disabled |
| retired Google browser account login | 不支援 | `UNAVAILABLE_ACCURATELY_DISABLED` |
| Claude／GitHub Copilot subscription | 不支援 | `UNAVAILABLE_ACCURATELY_DISABLED` |
| Apple Foundation Models | iOS only | `UNAVAILABLE_ACCURATELY_DISABLED` |

## A. Direct API Key

對OpenAI與Gemini API key分別執行：

- [ ] 從clean、固定integration SHA的Windows packaged app啟動。
- [ ] 選擇正確Direct API preset；確認Base URL為產品固定官方endpoint。
- [ ] 輸入測試key並取得模型清單；raw log不得出現key。
- [ ] 選擇明確模型，完成兩次不同challenge的短對話。
- [ ] 完全退出App後重啟，再完成一次對話，證明DPAPI persistence。
- [ ] 清除key；確認`hasCredential:false`且下一次models/chat fail closed。
- [ ] 分別驗證401、403、429、timeout與cancel的去敏訊息。

記錄：`CODE_SHA`、package hash、provider、model、exit/status、去敏raw log路徑。不要記錄credential。

## B. ChatGPT／Codex subscription

前置：產品擁有合法client registration，且capabilities只宣告`chatgpt-subscription`。

- [ ] 未配置client ID時，UI準確disabled，不出現假登入成功。
- [ ] 配置合法測試client後開始device authorization；Renderer只顯示公開verification URL與user code。
- [ ] 在官方頁面完成授權；確認status變成authenticated。
- [ ] 取得broker提供的模型清單，完成兩次不同challenge對話。
- [ ] 完全退出App後重啟；確認仍可透過Main broker對話，Renderer/storage/log無token。
- [ ] Logout；確認token被清除、in-flight refresh被取消且不能復活credential。
- [ ] 驗證authorization pending、slow down、expired device code、deny、timeout與cancel。

## C. Grok／SuperGrok subscription

前置：xAI核准Voice Practice client ID與scope，capabilities只宣告`grok-subscription`。

- [ ] 未配置核准client ID時，UI準確disabled。
- [ ] 開始device authorization；只顯示公開verification URL與user code。
- [ ] 完成官方授權並確認authenticated status。
- [ ] 取得模型清單，完成兩次不同challenge對話。
- [ ] 在接近到期狀態驗證Main Process refresh；Renderer不得取得token bundle。
- [ ] App restart後再次對話。
- [ ] Logout後確認refresh不能復活已清除token。
- [ ] 驗證pending、slow down、deny、timeout、rate limit與cancel。

## D. 不支援路徑

- [ ] Windows UI中沒有retired Google browser account login入口或相關DOM。
- [ ] 沒有Claude／Copilot subscription provider ID或generic OAuth bridge。
- [ ] 沒有Hermes CLI proxy、consumer cookie/session scraping或Renderer token API。
- [ ] Apple Foundation Models不在Windows provider清單中。

## 驗收結果格式

每個provider只能回報以下之一：

- `MANUAL_PROVIDER_LOGIN_PASS`：固定integration SHA、packaged app與所有清除／重啟／去敏gate都有raw evidence。
- `MANUAL_PROVIDER_LOGIN_FAIL:<reason>`：有可重現失敗與去敏證據。
- `MANUAL_PROVIDER_LOGIN_NOT_RUN:<reason>`：未執行或缺client registration／帳號／Windows runner。

未完成以上完整流程前，不得回報整體Windows auth PASS。
