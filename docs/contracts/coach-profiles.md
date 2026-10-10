# 教練 Profile 設定

狀態：已實作（Web、macOS、Windows、iOS 共用同一份網頁 UI 與資料格式）。

## 範圍

- 固定 8 位教練：Heart、Bella、Nicole、Sky、Adam、Michael、Onyx、Fenrir。不能新增或刪除。
- 每位都可以調整：聲音、語速、音高、名字、職稱、一句話介紹、頭像顏色、個性與教學風格（會送給 LLM）、打招呼語。
- 每位都可以一鍵恢復預設（要確認）。
- 目前選的教練會記住，重開 App 不會回到 Heart。

## 資料模型

存在 localStorage `vp_coachProfiles`，而且只存與預設不同的欄位（overrides）。恢復預設就是刪掉該教練的 overrides。實作：`apps/web/runtime/coach-profiles.js`。

```json
{
  "version": 1,
  "selected": "af_heart",
  "coaches": {
    "af_heart": {
      "name": "Heart",
      "style": "Warm and patient. Praise effort, correct gently, one tip at a time.",
      "voice": { "kokoro": "af_heart", "ios": "com.apple.voice.enhanced.en-US.Samantha" },
      "rate": 1.0,
      "pitch": 1.0
    }
  }
}
```

讀取時逐欄驗證，不合規的欄位丟掉、改用預設，不會讓整份設定失效：

| 欄位 | 規則 |
|---|---|
| name | 1–20 字，去掉前後空白 |
| title | 0–20 字 |
| desc | 0–80 字 |
| color | 8 個預設色之一；頭像的淺色和髮色跟著主色 |
| style | 0–400 字，中英文都可以，可換行 |
| greeting | 1–160 字 |
| voice.kokoro | 內建 8 個 Kokoro 聲音之一 |
| voice.ios | 字串；執行時找不到這個聲音就改用自動 |
| rate | 0.8–1.2 |
| pitch | 0.8–1.2，只對 iOS／Web 系統語音有效 |

名字、介紹、style 一律用 textContent 顯示，不會被當成 HTML。

## 套用方式

1. 顯示：教練卡、頭像、標題、打招呼都讀合併後的 profile。
2. 聲音：
   - macOS／Windows：用 `voice.kokoro`，語速帶 `rate`。Kokoro 不支援音高，所以這兩個平台不顯示音高滑桿。
   - iOS：用 `voice.ios`，語速與音高換算成 `AVSpeechUtterance` 的參數。沒有設定時，依教練的性別與口音挑一個預設聲音（Heart Samantha、Bella Karen、Nicole Moira、Sky Tessa、Adam Daniel、Michael Rishi；Onyx、Fenrir 與其他教練共用），並避開 Eloquence 與趣味聲音。
3. LLM：system prompt = 固定的英語教練規則 + 教練名字 + style。固定規則（只說英文、回答簡短）放在最前面；style 只能補充，不能覆蓋。
4. 換教練或改 style 時清掉目前的對話重新開始，與原本的行為一致。

## 不做的事

- 不提供教練設定的匯出／匯入。
- 不限制 style 的語言；只說英文的規則已經寫在固定前綴裡。
- 不提供自由選色器，只能選 8 個預設色，以免頭像配色亂掉。

## 驗證

- 單元測試：profile 的讀寫、驗證、合併、恢復預設；prompt 組合（規則在前、style 有長度上限）；各平台挑聲音的邏輯。
- 實機：在 iPhone 和 macOS 打包版各改一位教練的聲音、語速、style，實際對話一輪確認有生效；恢復預設後回到原樣。
