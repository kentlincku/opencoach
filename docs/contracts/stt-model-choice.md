# STT 模型自選與裝置推薦

狀態：已實作（macOS、Windows）。iOS 使用 Apple Speech，不適用本規格。

## 四檔 STT（英文）

TTS 固定 Kokoro v1.0 fp16，不開放選擇。STT 提供四檔，使用者可選任一檔；推薦只是預設。

| 檔位 | macOS（MLX） | Windows（CTranslate2，CPU int8） | 下載量 |
|---|---|---|---|
| 極速 | mlx-community/whisper-tiny.en-mlx | Systran/faster-whisper-tiny.en | 約 75 MB |
| 快速 | mlx-community/whisper-base.en-mlx | Systran/faster-whisper-base.en | 約 145 MB |
| 平衡 | mlx-community/whisper-small.en-mlx | Systran/faster-whisper-small.en | 約 485 MB |
| 精準 | mlx-community/whisper-large-v3-turbo | dropbox-dash/faster-whisper-large-v3-turbo | 約 1.6 GB |

每個模型都固定在 Hugging Face 的某個 commit，並記錄每個檔案的大小與 SHA-256 以及整包的 treeDigest。完整清單在 `resources/macos-model-packs.json`、`resources/windows-model-packs.json`；`docs/contracts/stt-tier-candidates.json` 保存查證時的原始紀錄。

| 平台 | 檔位 | modelId | HF repo @ commit | bytes |
|---|---|---|---|---|
| macOS | 極速 | whisper-tiny-en-mlx | mlx-community/whisper-tiny.en-mlx @ 5f4dafbb | 74,418,066 |
| macOS | 快速 | whisper-base-en-mlx | mlx-community/whisper-base.en-mlx @ aa0678c3 | 143,723,394 |
| macOS | 平衡 | whisper-small-en-mlx | mlx-community/whisper-small.en-mlx @ 52a88bf6 | 481,306,466 |
| macOS | 精準 | whisper-large-v3-turbo-mlx | mlx-community/whisper-large-v3-turbo @ a4aaeec0 | 1,613,977,880 |
| Windows | 極速 | faster-whisper-tiny-en | Systran/faster-whisper-tiny.en @ 0d3d19a3 | 78,090,594 |
| Windows | 快速 | faster-whisper-base-en | Systran/faster-whisper-base.en @ 3d3d5dee | 147,769,510 |
| Windows | 平衡 | faster-whisper-small-en | Systran/faster-whisper-small.en @ d1d751a5 | 486,098,798 |
| Windows | 精準 | faster-whisper-large-v3-turbo | dropbox-dash/faster-whisper-large-v3-turbo @ 0a363e91 | 1,621,665,983 |

授權：
- Systran 與 dropbox-dash 的 repo 標示 MIT。dropbox-dash 原名 mobiuslabsgmbh，repo 轉移後 commit 與檔案位元組都沒變。
- mlx-community 的轉檔 repo 沒有標示授權，provenance 記為來源 OpenAI Whisper 的 MIT。
- App 只接受同一個 repo 內的下載轉址，跨 repo 的轉址一律拒絕（`UNTRUSTED_RAW_MODEL_URL`）。

## 推薦規則

硬體資訊只在 Main Process 取得（記憶體總量、CPU 型號、架構），不經過 renderer，也不會上傳。

macOS（只支援 Apple Silicon）：
- 記憶體 16 GB 以上：精準。
- 其他：快速。

Windows（只用 CPU，固定 4 個執行緒；實測 8 緒不比 4 緒快）：
- 有 AVX2 且記憶體 16 GB 以上：平衡。
- 有 AVX2 且記憶體 8 GB 以上：快速。
- 其他：極速。
- 精準不推薦。選了會顯示「CPU 上每句約 5 秒以上」的提醒。

實測只有兩台機器（一台 Apple Silicon Mac、一台 Intel 桌機）。其他硬體一律用保守值。

## 準確度的呈現

沒有真人錄音語料，用合成語音量不出四檔的準確度差異。因此選單上的準確度只用文字描述，不顯示 WER 或百分比。速度顯示實測的大約值，並標明是哪台機器量的。

## UI 行為

- 設定頁列出四檔：檔位名稱、模型名、下載大小、預估速度、準確度描述。
- 推薦的那一檔標「推薦」，並顯示原因（例如「依此裝置 16 GB 記憶體」）。
- 選了就下載；下載完成後要完整結束 App 再開啟才會生效，不熱切換。
- 「使用中」「已下載」「未下載」分開顯示。
- 原生語音要 STT 和 TTS 都就緒才啟用；缺模型時仍可用文字對話。

## 移除

- 只能刪「已下載、而且不是使用中」的模型。使用中包括：sidecar 目前持有的模型、設定指向的模型、正在安裝的模型。
- 刪除由 Main 驗證，並和安裝互斥。失敗可以重試，不會把刪到一半的狀態當成成功。

## 信任根與選擇

- 信任根的 `sttRoot` 是允許清單 `{ allowed: [{ modelId, identity }] }`，每一項都是 raw-files + treeDigest。TTS 的 `onnxModel`、`onnxVoices` 只綁一個模型。
- catalog、manifest 的模型集合必須等於所有允許項目的聯集。
- 使用者選的 STT modelId 存在 Main 的設定檔（userData），不放在 renderer 的 localStorage。
- 啟動時一定要明確帶入選定的 modelId（四檔都相容時，沒帶會回 `AMBIGUOUS_MODEL`）。模型不存在或驗證失敗時，不會自動改用別檔，而是顯示「需要下載」或錯誤原因。
- 只為選定的 STT 與 TTS 建立 snapshot lease。

## 多語言預留（目前只開英文）

- 檔位以「練習語言 + 檔位」為單位；同一檔位在不同語言可以對應不同模型。
- 選擇以語言為 key 保存：`{ [language]: sttModelId }`。切換練習語言時用該語言自己的選擇；沒選過就套用推薦。
- 移除保護只看目前練習語言。其他語言選定的模型可以刪，之後切回該語言時顯示「需要下載」。
- 不從 UI 介面語言推導練習語言。
- tiny.en、base.en、small.en 只能辨識英文；large-v3-turbo 是多語模型。開放其他語言時，要另外審查並更新 catalog 的 languages。

## 驗收層級（不能互相取代）

1. 單元測試：推薦規則、選擇保存、移除保護。
2. 真實下載：每檔下載一次並驗證雜湊。
3. 打包好的 App 實際對話：STT → 本機 LLM → TTS，並記錄端到端延遲。
4. 移除：刪掉未使用的模型、確認使用中的刪不掉、重開後狀態正確。
