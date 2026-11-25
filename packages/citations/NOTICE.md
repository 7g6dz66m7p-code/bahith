# Third-party material in @bahith/citations

## CSL styles (`styles/`)

From the Citation Style Language styles repository,
<https://github.com/citation-style-language/styles>, licensed under the
[Creative Commons Attribution-ShareAlike 3.0 Unported License](https://creativecommons.org/licenses/by-sa/3.0/)
(each file carries its own `<rights>` element and author credits).

- Upstream commit: `e5c42aca616b16fa41e1512fcf4103072c1e5f2f` (branch `master`)
- Downloaded: 2026-11-19, from `https://raw.githubusercontent.com/citation-style-language/styles/<commit>/<file>`
- Files are stored unmodified. Do not hand-edit them; to update, download a new commit and
  update this table and the golden tests.

| File                              | Title                                                         | `<updated>`               | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `apa.csl`                         | APA Style 7th edition                                         | 2026-02-07T00:00:00+00:00 | `3917def5fc951b104d64216c3373096042368b9704ba269ca83c14ebaba889fc` |
| `chicago-author-date.csl`         | Chicago Manual of Style 18th edition (author-date)            | 2025-02-09T00:00:00+00:00 | `002fade78d7e4fe9d42936a16b43a8066b097013f6255df40b1bfba6631eff9b` |
| `chicago-notes-bibliography.csl`  | Chicago Manual of Style 18th edition (notes and bibliography) | 2025-02-09T00:00:00+00:00 | `4b6be4bceaf8f3c31b49331c9f9e38c977f666d6ab80e19a2ac8482c7511abeb` |
| `modern-language-association.csl` | MLA Handbook 9th edition (in-text citations)                  | 2026-02-03T00:00:00+00:00 | `e1432698ef28938d044b06bd45ddcc57d6b974cec25f71007075646a11f99484` |

(The Chicago notes style is named `chicago-notes-bibliography.csl` upstream since the 18th
edition; `chicago-note-bibliography.csl` no longer exists.)

## CSL locales (`locales/`)

From the Citation Style Language locales repository,
<https://github.com/citation-style-language/locales>, licensed under the
[Creative Commons Attribution-ShareAlike 3.0 Unported License](https://creativecommons.org/licenses/by-sa/3.0/).

- Upstream commit: `21a175a1d84cc1792dd73f5a627de004fba5b207` (branch `master`)
- Downloaded: 2026-11-19, from `https://raw.githubusercontent.com/citation-style-language/locales/<commit>/<file>`
- Files are stored unmodified.

| File                | `<updated>`               | SHA-256                                                            |
| ------------------- | ------------------------- | ------------------------------------------------------------------ |
| `locales-en-US.xml` | 2026-01-10T00:00:00+00:00 | `ac864c7c21166b4390d82c31792cdc509400727fa0060b43d8aa17e07f9cb079` |
| `locales-ar.xml`    | 2026-11-17T19:00:00+01:00 | `4b9240652d3bbf9eb2d9a5fc5894810c2180c40624c55e605f3297f4d8f03215` |

## npm packages

| Package                                     | License               | Notes                                                                                                                   |
| ------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `@citation-js/core` 0.9.0                   | MIT                   |                                                                                                                         |
| `@citation-js/plugin-csl` 0.9.0             | MIT                   | Depends on `citeproc` (below) for CSL processing.                                                                       |
| `@citation-js/plugin-bibtex` 0.9.0          | MIT                   |                                                                                                                         |
| `@citation-js/plugin-ris` 0.9.0             | MIT                   |                                                                                                                         |
| `citeproc` 2.4.63 (transitive, citeproc-js) | CPAL-1.0 OR AGPL-3.0+ | LICENSE text: CPAL v1+ or AGPL v3+ (package.json says `AGPL-1.0`). Copyright (c) 2009-2019 Frank Bennett. See ADR-0008. |
| `zod` 4                                     | MIT                   |                                                                                                                         |
