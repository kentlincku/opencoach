# Packaged runtime candidate

此目錄產生 **candidate build，不是可發布／可推論證明**。Windows 路線固定 CPython 3.11 x64、CPU；Linux 只能執行可攜輸入驗證與測試，不能建置或驗收 Windows runtime。

## Windows：來源、資料、native 分開驗證

- `requirements-windows-x64.in` 記錄第三方直接依賴；`.lock.txt` 固定 Windows 相容 wheel 的版本與 SHA256。每套件在 wheelhouse 中只選一個相容 wheel。
- **第三方 lock 不是完整 runtime**。`native/python/requirements-windows.txt` 也不含完整 speech vendor；不要只安裝它就宣稱 runtime ready。
- 原固定 code-only wheel SHA256 為 `472a6fdfd3c3820add475fce3f547623098b0978f8e60bb8608ab16b3ec47e80`，由既有 `scripts/build-speech-vendor.py` 離線流程產生。它不包含完整詞典、spaCy/VAD 或 Kokoro compatibility 資源，不能直接當正式 runtime。
- `windows_bundle.py` 將固定 code wheel 與 operator 提供的完整、逐檔 hash-bound 資源組裝成 **不同版本／hash 的 deterministic wheel**，產生新 RECORD、附加 provenance 與 review documents。原 code、notices、`CODE_ONLY=True` 及原 provenance 保留；新附件不把歷史 code-only 宣告偷偷改成 native／法律通過。
- 正式資源與 model/profile 相容性必須另行取得及驗證；repository 不提供 synthetic profile 當正式信任資料。

## 私有 bundle input

只在自己控制、無 symlink/reparse 的目錄準備輸入。由已審閱的來源取得 bundle JSON 的預期 SHA256；不要用「對任意下載檔自行算 hash」替代來源審查。

Bundle JSON 的 exact fields：

- `schemaVersion`: 整數 `1`。
- `codeWheel`: `{path, bytes, sha256}`，path 相對於 bundle 所在目錄，必須符合上述固定 code wheel hash。
- `resourceRoot`: bundle 目錄下相對路徑；以下 files 使用相對於該 root 的完整 package destination。
- `files`: 完整非空 `{path, bytes, sha256}` 陣列，拒絕缺檔、多檔、重複／大小寫碰撞、變更、symlink／reparse 與非資料執行檔。
- `spacySource`: `{path, bytes, sha256, prefix}`，原始來源 ZIP 與其中完整 model 目錄 prefix。ZIP 該目錄所有檔案必須一一對上 payload，不可以只挑能讓 fixture 通過的少數檔案。
- `reviews`: exact keys `vendor-code`, `misaki`, `spacy`, `kokoro`, `vad`, `third-party`，每個值為已審閱文件的 `{path, bytes, sha256}`。

資源目的地必須包含：

```text
voice_practice_speech_vendor/resources/misaki/en/us_gold.json
voice_practice_speech_vendor/resources/misaki/en/us_silver.json
voice_practice_speech_vendor/resources/spacy/en_core_web_sm-3.8.0/<完整原始 model 目錄>
voice_practice_speech_vendor/resources/kokoro/compatibility.json
voice_practice_speech_vendor/resources/kokoro/vocabularies/<profileId>.json  # runtime-profile 時
voice_practice_speech_vendor/faster_whisper/assets/silero_vad_v6.onnx
```

Compatibility JSON 必須符合實際 `voice_runtime/onnx_engine.py` 消費契約：唯一 profile/model bytes/hash，明確 `embedded` 或 `runtime-profile` vocab；後者必須有正確檔案大小／hash 與 canonical vocab digest。前者的 embedded vocab 仍需 native model 執行時驗證。詞典讀取、完整 spaCy load、VAD、Kokoro 數值／音訊相容性不由檔名與 JSON 外形保證。

Review 文件的 hash binding **不是自動法律核准**：文件須記錄各來源、版本與取得方式、授權原文／notice、可再散布判斷及 compatibility 證據；資料與 native library 的授權不得從 Python package label 推論。PyInstaller 的 GPL／bootloader exception 亦須在最終 SBOM／授權審查明列，不宣稱整包絕無 GPL/LGPL。任何未確認項目維持 BLOCKED／NOT_RUN，不能靠填入任意 review 文字解除。

## 離線準備與實際建置

純 stdlib preparation 可在非 Windows 機器執行；仍須完整真實輸入，沒有隱含下載。所有 output/prepared 目錄必須是新目錄，失敗的自有部分輸出保留供調查，不覆寫或清除既有資料。

```powershell
python -B spikes/packaged-runtime/build-runtime.py --prepare-only --bundle $bundle --bundle-sha256 $approvedBundleSha --wheelhouse $wheelhouse --output $prepared
```

這只回報 `PREPARED_INPUT_BYTES_ONLY`。產生 `source/`、新的 vendor wheel、`install.lock.txt`、`preparation.json`；generated install lock 包含該新 wheel 的完整 hash 與明確 file URI，因此搬移 prepared 目錄後應重新準備，不手改 lock。

Windows native runner 必須使用乾淨、專用、無 pip seed 的 **Windows x64 CPython 3.11 venv**，不得帶入 `PYTHONPATH`／`PYTHONHOME`。透過既有 uv 使用 `--offline --no-index --no-deps --require-hashes --only-binary :all: --find-links <wheelhouse>` 安裝 generated `install.lock.txt`，不要裝 upstream K/M/F、soundfile、PyAV、eSpeak、CUDA 或 DirectML variant。不要額外裝未鎖定套件；不要啟用 compile-bytecode。驗證器容許 wheel 本身與 inert installer bookkeeping，不容許 stale/unowned bytecode／`.pth`。

```powershell
.venv/Scripts/python.exe -I -B spikes/packaged-runtime/build-runtime.py --verify-only --bundle $bundle --bundle-sha256 $approvedBundleSha --wheelhouse $wheelhouse --prepared $prepared
.venv/Scripts/python.exe -I -B spikes/packaged-runtime/build-runtime.py --bundle $bundle --bundle-sha256 $approvedBundleSha --wheelhouse $wheelhouse --prepared $prepared --output $newBuildOutput
```

Actual driver、Windows spec 均重新驗證 bundle／wheelhouse／prepared source／installed file bytes；使用 `noarchive`、明確 hiddenimports／datas、`_internal` onedir。分析結果與 post-build 檢查必須通過，並保存 `post-build.json`。`--dry-run` 不跳過 Windows input gate。檔名 denylist 只是一道防護，並不是整包授權證明或無惡意程式證明。

開發用 `scripts/setup-windows.ps1 -Bundle ... -BundleSha256 ... -Wheelhouse ... -Prepared ...` 串接相同流程並檢查各 command exit。該入口保留既有 npm／model 安裝行为：**只有在同意下載且完成資料／授權審閱後才執行**；既有 `.venv` 不會自動清理，混有舊套件時需另行保留／移開並使用乾淨環境。`-VerifyAssetsOnly` 仍只檢查既有兩個 Kokoro asset hash，不代表完整 runtime／資源／真推論驗證。

## 可攜證據與發布門檻

可攜測試使用真固定 code wheel、真小檔／ZIP／RECORD，明示 synthetic 詞典／模型資料及 PyInstaller/native doubles。包含資源缺／多／變更、原始 spaCy 完整性、profile conflict、review/hash、path/reparse、lock/tag/RECORD、installed bytes、spec collection、post-build layout 的正反向控制。這不是實際 Windows wheel 安裝或原生 PyInstaller 執行證明。

Windows 必須重新建置 runtime ZIP，再建 Electron EXE；不可把舊 ZIP 重包。發布前以沒有 Python/uv 的乾淨帳號實際執行 canonical health、STT、TTS、mic→LLM→speaker、CPU provider，以及 Stop／restart／Quit 的原始 process-tree 終止證據；另驗安裝／升級／卸載、ACL/reparse、size/RSS/startup、SBOM／資源再散布與簽章。DirectML 是另行 native 驗證／核准門檻，不能把 CPU-only ZIP 冒稱 DML 版本。runtime 程式碼在 win/cuda-main 工程版本的開發環境預設 `VOICE_ACCELERATOR=auto`（打包版 frozen 未設定時預設 `cpu`；有 CUDA 就用，沒有就退回 CPU；可設 `auto`／`cpu`／`cuda`），但本打包流程仍只產出 CPU 版：lock 不含 onnxruntime-gpu／nvidia-*，FORBIDDEN／BINARY_DENY 照舊擋 cuda／cudnn，ZIP 不得冒稱 CUDA 版本。Linux PASS 不替代這些門檻，空的正式 trusted manifests 不得填入假 URL/hash。

## macOS R55 engineering（產品尚未驗收）

Darwin arm64 builder 使用以下 R55 lock／collection 流程。建置與空參數 probe 只提供工程證據；產品、真實 reader lifetime、資源、再散布及 activation 仍各自需要驗收。Windows 既有流程保持原樣。

R55 Darwin engineering builds use `requirements-darwin-arm64-cp311.lock.json` and
`scripts/r55-dependencies.py`. Exact official D1 wheel bytes, immutable selected
MLX Whisper/langcodes code and the existing K/M patches are admitted by a
non-author receipt before acquisition; actual ZIP/RECORD/license/startup receipts
are reviewed before offline dedicated CPython 3.11 installation. The existing
interpreter, SDK and Apple tools are used. No sdist or installer backend runs.

An independently reviewed `r55-platform-preflight.py` captures the existing
CPython platform implementation's real `uname -p` and `file -b` outputs under
one 30-second owned-tool deadline. The build verifies the five original inputs,
live OS snapshot and retained output hashes before seeding CPython's own metadata
caches. Neither functions nor the installed child/network/resource guard change.
The complete build shares one 3600-second owner deadline, including input review,
one packager invocation, output verification, receipts and original-handle cleanup.

The exact existing interpreter's hardlinked `libpython3.11.dylib` is separately
pinned by original path, inode, link count, stable bytes and independent review.
Only its single matching BINARY row is copied to fresh owned staging with the
same library name and original mode; the original remains intact. The collection
receipt records original-to-copy lineage and verifies the copy has nlink=1.
Other hardlinks remain refused. This exception grants no model-payload ingestion.

The Darwin spec follows current MLX and Kokoro ONNX CPU imports, keeps original
loader destinations and materializes reviewed loader aliases during collection.
Pre/post installed RECORD, collection, native arm64 ABI, full output inventory,
SBOM and source-to-binary receipts are mandatory. Incomplete D2 inputs produce
`ENGINEERING_CODE_ONLY_NOT_ACTIVATABLE`; production admission still refuses.
No health, model, audio, activation or production manifest is granted by a build.

The private R55 ledger is derived from the common Git directory, is append-only,
claims before dispatch and allows five build epochs and twenty native transactions.
An unknown closure permanently blocks further build/native dispatch. Each native
transaction shares a 30-second absolute deadline and a five-second cleanup reserve.
`scripts/r55-native-controls.cjs controls` uses only its fixed no-spawn first-party
fixture and original host-owned handles. `probe` requires a separately reviewed,
newly built candidate and sends only `runtime.probe` with empty parameters.
Neither command qualifies MLX/Metal/ORT reader or broker retirement. Production
Darwin and unknown closures continue to refuse managed lease release. Existing
Windows lifetime and packaging behavior remains unchanged.

The ORT upstream wheel contains three serialized sample models. R55 never
acquires that complete wheel. `r55-ort-metadata.py` reads only the exact EOCD,
central directory and RECORD metadata. The source lock identifies eleven
non-overlapping code-only ranges, 305 original code/native/license members and
three excluded model members. `darwin_ort.py` validates HTTP 206 and exact
Content-Range/length before receiving, then original local headers, bounded
deflate, CRC, byte length and every selected member's original RECORD SHA256.
It produces a distinct `onnxruntime` code-only wheel with original-member and
rewritten RECORD provenance. The publisher whole-wheel SHA is informational
and is explicitly unverified; no model body or full-wheel fallback is allowed.
Upstream example lookup retains its real missing-resource behavior.

The isolated installer grants a write exception only for reviewed exact D1
unit-fixture destinations. Model/resource reads and foreign writes remain
rejected, and this exception cannot be configured during a build epoch.
