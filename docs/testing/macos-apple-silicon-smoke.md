# Apple Silicon 原生語音 Smoke Test SOP

## 目的

在真實 Apple Silicon Mac 驗證目前開發版的 Electron → preload IPC → main process → persistent Python sidecar → MLX Whisper／Kokoro Python 路徑。此 SOP 不等於簽章、notarization 或 `.dmg` 安裝測試。

## 預期 Backend

```text
Platform: darwin / arm64
STT auto: mlx-whisper（若已安裝）→ faster-whisper
TTS auto: kokoro-python（若已安裝）→ kokoro-onnx
目前 setup-macos.sh 安裝：mlx-whisper、kokoro Python
```

## 測試前準備

- Apple Silicon Mac（M1 或更新；測試紀錄需寫實際型號）。
- Node.js/npm、`uv`、Git。
- 穩定網路；首次使用可能下載模型。
- 至少一段 5–10 秒、無個資的英文音訊，或現場朗讀固定句：

```text
The quick brown fox jumps over the lazy dog. Today is a good day to practice English.
```

- 不要把私人錄音加入 Git。

## 預先固定的 Smoke 門檻

模型下載時間獨立記錄，不計入 cold initialization；cold run 指 assets 已在本機、全新 sidecar process 的第一次推論。

| 項目 | Pass 門檻 |
|---|---|
| STT normalized WER | `<= 0.20` |
| STT cold initialization＋first inference | `<= 60 秒` |
| STT warm RTF | `<= 1.0` |
| TTS cold initialization＋first synthesis | `<= 30 秒` |
| TTS warm synthesis RTF | `<= 1.0` |
| STT＋TTS sidecar peak RSS | `<= 8 GiB` |
| TTS output | 24000 Hz、duration > 0、無截斷／爆音／長段靜音 |

```text
WER = (substitutions + deletions + insertions) / reference_word_count
RTF = inference_seconds / input_or_output_audio_seconds
```

WER 正規化固定為：Unicode lowercase、ASCII 標點替換為空白、連續空白縮成一格、以空白切詞；不得人工改寫 hypothesis。STT RTF 分母是輸入音訊秒數，TTS RTF 分母是輸出音訊秒數。

任一效能門檻失敗時仍保存數據，但只能判為 Conditional Pass／Fallback-only，不能標為 Native Supported。

## A. 鎖定受測 SHA 並建立 clean-room clone

先指定要測試的完整 40 字元 commit SHA，不直接測會移動的 branch tip：

```bash
export TEST_SHA="<40-character-commit-sha>"
export TEST_ROOT="$(mktemp -d)"
git clone https://github.com/kentlincku/opencoach.git "$TEST_ROOT/repo"
cd "$TEST_ROOT/repo"
git checkout --detach "$TEST_SHA"
test "$(git rev-parse HEAD)" = "$TEST_SHA"
test -z "$(git status --porcelain)"
```

Pass：checkout 後 HEAD 等於 `TEST_SHA` 且工作樹乾淨。後續不得執行 `git pull`、切換 branch 或修改受測程式；測試紀錄另存於 repo 外，完成去敏後才複製回 evidence 位置。

## B. 建立測試紀錄與系統盤點

```bash
sw_vers
uname -m
system_profiler SPHardwareDataType
node --version
npm --version
uv --version
git rev-parse HEAD
df -h .
```

Pass：`uname -m` 為 `arm64`，磁碟空間足以安裝 dependencies 與模型。依[公開測試規範](README.md)只提交去敏摘要；原始裝置log留在受控儲存空間。

## C. 全新環境 setup 與獨立 idempotency 測試

Clean-room clone 中不得存在 `.venv`：

```bash
test ! -e .venv
bash scripts/setup-macos.sh
export VOICE_RUNTIME_PYTHON="$PWD/.venv/bin/python"
"$VOICE_RUNTIME_PYTHON" --version
```

Pass：第一次 setup 無錯誤、Python 為 3.11、相依套件安裝完成。這一輪才是 clean setup 證據。

接著在同一 clone 第二次執行，單獨驗證 idempotency：

```bash
bash scripts/setup-macos.sh
"$VOICE_RUNTIME_PYTHON" --version
```

Pass：第二次仍 exit 0，不刪除模型 cache 或使用者資料。不得以第二次成功取代第一次 clean setup 結果。

## D. G0 自動化 Gate

使用 sidecar 實際採用的 `.venv` Python，不依賴 PATH 上的 `python3`：

```bash
export PYTHON="$VOICE_RUNTIME_PYTHON"
test "$(git rev-parse HEAD)" = "$TEST_SHA"
test -z "$(git status --porcelain)"
"$PYTHON" -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.cjs
"$PYTHON" -m compileall -q native/python
"$PYTHON" -m json.tool contracts/voice-runtime.schema.json >/dev/null
"$PYTHON" -m json.tool contracts/runtime-protocol.json >/dev/null
node --check apps/desktop/main.cjs
node --check apps/desktop/preload.cjs
node --check apps/desktop/sidecar-client.cjs
node --check apps/desktop/hermes-bridge.cjs
git show --check --format= "$TEST_SHA"
git diff --check
```

Pass：所有測試及語法檢查 exit code 0，HEAD 仍等於 `TEST_SHA`，工作樹仍乾淨。記錄實際測試數，不沿用其他機器的數字。此命令集必須與 [README.md](README.md) 的 canonical G0 保持一致。

## E. Sidecar health preflight

```bash
RUNTIME_TMP="$(mktemp -d)"
VOICE_RUNTIME_TEMP_DIR="$RUNTIME_TMP" \
VOICE_STT_BACKEND=auto \
VOICE_TTS_BACKEND=auto \
"$VOICE_RUNTIME_PYTHON" -u native/python/voice_runtime/server.py <<'EOF'
{"id":"health-1","method":"runtime.health","params":{}}
EOF
rm -rf "$RUNTIME_TMP"
```

Pass：

- stdout 第一行是 `{"event":"ready","protocol":1}`。
- health `platform` 為 `darwin`、`arch` 為 `arm64`。
- `selectedStt` 為 `mlx-whisper`。
- `selectedTts` 為 `kokoro-python`。
- `ready` 為 `true`。

注意：health 不載入模型，因此只證明 dependency metadata 可見，不證明推論成功。

## F. 啟動 Electron 開發版

```bash
export VOICE_RUNTIME_PYTHON="$PWD/.venv/bin/python"
export VOICE_STT_BACKEND=auto
export VOICE_TTS_BACKEND=auto
npm start
```

Pass：

- Electron 視窗成功開啟。
- UI 可操作，沒有白畫面。
- Native runtime ready；若 UI 有 capability 顯示，內容與 E 節一致。
- Activity Monitor 或下列命令只看到預期的 sidecar process：

```bash
pgrep -fl 'voice_runtime/server.py'
```

記錄 sidecar PID，後續兩次 STT/TTS 之後 PID 必須相同。相同 PID 只證明 process 重用，不足以單獨證明模型只初始化一次。

## G. 真實 MLX Whisper STT

1. 在 UI 錄製／匯入固定 5–10 秒英文句子。
2. 記錄按下送出至 transcript 顯示的 wall-clock latency。
3. 以相同音訊再執行一次並記錄第二次 latency。
4. 再執行：

```bash
pgrep -fl 'voice_runtime/server.py'
```

Pass：

- 兩次都回傳非空英文內容；以固定正規化規則計算後 WER `<= 0.20`。
- 回傳 engine 為 `mlx-whisper`（若 UI 可顯示）。
- 第二次後 sidecar PID 不變，沒有重啟或重複 process。
- Assets 已快取後，cold initialization＋first inference `<= 60 秒`，warm RTF `<= 1.0`。
- 暫存音訊在成功後清除：

```bash
find "${TMPDIR:-/tmp}/voice-practice-runtime" -type f -print 2>/dev/null
```

預期沒有遺留本次錄音。若文字準確度不足，記錄實際 transcript，不自行修飾。

## H. 真實 Kokoro Python TTS

使用固定文字：

```text
Hello! This is the native Kokoro speech test on Apple Silicon.
```

以 `voice=af_heart`、`speed=1.0` 合成兩次，分別記錄 latency。

Pass：

- 兩次皆能播放完整語音。
- 沒有明顯截斷、爆音、長段靜音或異常速度。
- 回傳格式為 WAV、sample rate 為 24000 Hz（可由 debug／response 或另存測試輸出確認）。
- Cold initialization＋first synthesis `<= 30 秒`，warm synthesis RTF `<= 1.0`。
- Sidecar PID 與 F 節相同。
- Activity Monitor 記錄的 STT＋TTS sidecar peak RSS `<= 8 GiB`。

聲音品質是主觀證據，紀錄 `Pass／Marginal／Fail` 與理由，不只寫「可用」。

## I. Stop／Cancellation

1. 開始一次 STT，立即按 Stop。
2. 等待超過正常推論時間。
3. 開始一次 TTS，立即按 Stop。
4. 再開始新一輪對話。

Pass：

- 舊 STT 結果不覆寫新狀態。
- 舊 TTS 不播放。
- Cancel 後 native late failure 不啟動 Cloud STT／上傳音訊。
- 新一輪仍可正常使用。

限制：目前 adapter 保證晚到結果失效，但底層 Python inference 不一定能立即停止；應記錄 CPU/GPU 是否持續到該次推論自然結束。

## J. Degraded fallback

關閉 App 後，以不存在的 backend 啟動：

```bash
export VOICE_STT_BACKEND=missing-stt
export VOICE_TTS_BACKEND=missing-tts
npm start
```

Pass：

- App 不崩潰。
- Runtime health 為 degraded／`BACKEND_UNAVAILABLE`。
- 使用者仍能打字。
- TTS 可使用 system speech；STT 僅在使用者已設定對應 fallback 時才可切換 Browser／Cloud。

完成後恢復：

```bash
unset VOICE_STT_BACKEND VOICE_TTS_BACKEND
```

## K. 模型重用證據、結束與判定

- 同 PID 與第二次 latency 只作輔助證據。
- 完整的「模型未重新初始化」Pass 必須由 Task 4 benchmark instrumentation 或去敏 debug event 證明同一 sidecar 的 backend/model `loadCount=1`。
- 在 instrumentation 尚未完成時，此項填 `Not tested`，整體最多為 Conditional Pass，不得據此標為 Native Supported。

- 關閉 Electron，確認 sidecar process 結束。
- 確認 runtime temp 沒有本次音訊。
- 不刪除 Hugging Face／模型 cache，除非這次明確測 cold-cache。
- 將結果填入 evidence template。

整體 Pass 條件：D–J 無阻擋失敗，且 K 節有可稽核的 model load 證據。任何門檻失敗或 model reuse 尚未證明時，平台不得標示 Native Supported，只能維持 Beta／Fallback-only。
