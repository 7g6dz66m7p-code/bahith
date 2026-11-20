# PDF text fixtures

Synthetic sentences written for these tests (not research sources), rendered by two
different PDF producers so logical-order extraction is not tuned to one of them:

- `arabic-english-mixed.pdf` — Chromium (`node make_fixtures.cjs`).
- `libreoffice-arabic.pdf` — LibreOffice Writer 24.2: a python-docx document with
  `w:bidi`/`w:rtl` on the Arabic paragraphs, converted with
  `soffice --headless --convert-to pdf`. LibreOffice writes the lam-alef ligature as two
  characters in visual order, which the extractor must put back as lam, alef.
