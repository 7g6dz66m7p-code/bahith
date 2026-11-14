# SANAD Retrieve local extraction

From `apps/worker`:

```bash
uv run python -m bahith_worker.sanad INPUT.pdf \
  --mime-type application/pdf --output manifest.json
```

Supported MIME types:

- `application/pdf`: extracted text with actual, one-based PDF pages.
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document`: body
  paragraphs and table cells in document order; no invented page numbers.
- `text/plain`: strict UTF-8 text; no invented page numbers.

The command creates an exclusive, owner-readable/writable output file. It refuses
existing output files and an output path equal to the input. Standard output contains
only a file hash and counts. Failures write a stable error code to standard error,
without parser diagnostics, paths or research content. No credentials are required.

`extract_document(bytes, mime_type)` returns a Pydantic manifest. Serialize using
`manifest.model_dump_json(by_alias=True)` for the version 1 camelCase contract.
`fileSha256` identifies the original file bytes. `extractorVersion` records the parser
and extraction algorithm; `chunkerVersion` records the chunking algorithm.

Chunk `charStart`/`charEnd` offsets count Unicode **code points** in the referenced
unit's untouched extracted `content`. In JavaScript, use
`Array.from(unit.content).slice(charStart, charEnd).join('')`. Chunk text is always an
exact slice, including Arabic diacritics and supplementary-plane characters.

`tokenCount` is an explicit estimate: a Unicode word is split into groups of at most
twelve word characters, and each punctuation/symbol is one estimated token. This is
not a provider tokenizer or billing count. The default target is 600 estimated tokens
(maximum configuration 800), with 15% estimated-token overlap. Chunks stay within one
unit and are also bounded by `max_tokens * 12` code points; large whitespace gaps may
reduce a chunk's length and overlap. Whitespace-only units produce no chunks.

Limits include 50 MiB input, 100 MiB DOCX archive expansion, 20 MiB per DOCX entry,
2,000 archive entries, 20,000 units, 20 million extracted code points, 200,000 estimated
tokens per unit, and 50,000 chunks. PDF parsing uses bounded pypdf decoding and page
tree settings. Encrypted and malformed documents fail explicitly. A failed PDF page
creates an empty page unit and a `PAGE_EXTRACTION_FAILED` record; no text is inferred.

This local tool does not execute document instructions, call a model, verify scientific
claims, connect to storage/database, or authorize access. A future authenticated
ingestion service must validate workspace/project/source/file ownership before using
or persisting a manifest. There is deliberately no queue job accepting local paths.

Text extraction depends on the document's encoding and layout. Scanned PDFs need OCR,
which this module does not perform. DOCX headers, footers, text boxes and nested table
contents are not currently extracted. Missing or empty text is never filled in.

Validation:

```bash
uv run pytest
uv run ruff check .
uv run ruff format --check .
```
