# Windows Native Voice Artifact Publication Contract

本文件只定義可發布機制；目前 `resources/runtime-manifest.json` 與 `resources/model-manifest.json` 仍為 `release: unpublished` 且空集合，因此產品必須安全停用Native Voice。沒有公開artifact時不得填入示意URL、bytes或hash，也不得宣稱已有可分發包。

## 非self-describing trust root

Packaged Main Process以 `requireTrustedManifest: true` 載入兩份manifest。`apps/desktop/runtime-manifest.cjs` 對完整JSON做遞迴key排序的canonical serialization與SHA-256，並只接受編譯進程式碼的 `TRUSTED_MANIFEST_DIGESTS.runtime/model`。Manifest不能自行宣告或更改可信digest；未列入程式碼trust root的published manifest一律拒絕。`unpublished`只允許空`artifacts`／`models`。

正式發布時必須在隔離release branch完成：

1. 由Windows clean builder產生runtime ZIP與Kokoro ZIP；匿名HTTPS GitHub Release URL不得需要token，redirect每一跳都受host allowlist限制。
2. 記錄archive bytes/SHA-256。Windows runtime artifact另列完整sorted `files[]`（path、bytes、SHA-256）、`fileCount`及`treeDigest`；內部`runtime-manifest.json`必須與外部可信fileset逐項相符。
3. Kokoro model entry必須固定immutable `revision`、總license，並在`assets[]`逐項列出ONNX與voices的role/path/bytes/SHA-256/license。Artifact `files[]`必須與全部assets完全相等；不接受額外、缺少、重複、symlink或special file。
4. 在不改內容後計算`canonicalManifestDigest()`，由獨立review把runtime/model digest加入程式碼trust root。禁止由下載內容或同一manifest提供trust root。
5. 用匿名clean profile重抓URL，驗證Content-Length、stream byte cap、SHA-256、secure ZIP extraction、fileset與health，再執行固定SHA Windows封裝/E2E。
6. Artifact或manifest任一byte變更都需要新release ID、hash、trust-root code review與完整重跑；禁止沿用舊digest。

## 啟用與spawn安全

安裝只經partial download → hash/bytes → private staging → complete fileset/tree → health → atomic rename與metadata。每次packaged啟動會把verified runtime/model複製到隨機private launch snapshot，對snapshot同步重驗後立即spawn；Kokoro ONNX與voices路徑只由trusted model metadata建立。Parent `PYTHONPATH`、`PYTHONHOME`、`NODE_OPTIONS`、Electron flags及所有未驗證`VOICE_*`不會進入packaged sidecar環境。

## 尚未完成的release gates

- Runtime/model匿名公開artifact、真實bytes/hash/revision/license review：`NOT_RUN — artifacts unpublished`。
- Authenticode/timestamp、Defender/SmartScreen、NSIS/Portable clean-machine lifecycle：`NOT_RUN — Windows release executor`。
- DirectML/CPU真實Kokoro與faster-whisper推論、硬體RTF、麥克風／喇叭：`NOT_RUN — Windows hardware executor`。
