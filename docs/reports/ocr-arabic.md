# Arabic OCR — model choice (2026-11-25)

Quote matching was not relaxed: verbatim-v2 still requires every letter, diacritic,
digit and punctuation mark; only whitespace runs are folded.

| Arabic model                                              | Size   | Time per 2-page scan (4 vCPU, idle) | Latin gibberish tokens on the hardest page | `pnpm eval` |
| --------------------------------------------------------- | ------ | ----------------------------------- | ------------------------------------------ | ----------- |
| Distribution standard (`tesseract-ocr-ara`)               | 1.4 MB | 4.23 s                              | 4 (`E539`, `Lgl`, `WLS`, `lo Jl`)          | 100%        |
| **tessdata_best** (pinned `e12c65a`, SHA-256 `ab9d157d…`) | 13 MB  | 4.88 s (+15%)                       | **0**                                      | 100%        |

Same page, standard model: `ستين راوياً: E539 تسجيلاتها WLS` — best model:
`ستين راوياً, وفُرّغت تسجياتها كتابياً` (one remaining misread: `تسجياتها`).

Decision: tessdata_best in the worker image (`docker/worker.Dockerfile`), CI and local
development (`scripts/install-arabic-ocr-model.sh`), both checksum-verified. Each extraction
records the model fingerprint (`…-ara-<sha256[:12]>-…`), so text read by different models
is never mixed silently.

CI note: GitHub's runners use AVX2/FMA code paths in Tesseract's LSTM and misread a word on
page 1 with the standard model (quote x11 rejected — correctly, the text is not there).
