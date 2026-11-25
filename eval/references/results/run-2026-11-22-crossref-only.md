# Fabricated-reference detection — live run

Run live (providers: **crossref** — diagnostic Crossref-only configuration) from 2026-11-22T06:06:58.247Z to 2026-11-22T06:08:24.639Z (Node v22.23.4). Dataset generated 2026-11-21T13:10:44.778Z. No response cache.

| Kind       | Total | verified | mismatch | not_found | unverifiable | error | pass |
| ---------- | ----- | -------- | -------- | --------- | ------------ | ----- | ---- |
| real       | 100   | 100      | 0        | 0         | 0            | 0     | 100  |
| fabricated | 50    | 0        | 0        | 50        | 0            | 0     | 50   |
| mismatched | 25    | 0        | 25       | 0         | 0            | 0     | 25   |

| Metric                                                          | Value            | Target | Met |
| --------------------------------------------------------------- | ---------------- | ------ | --- |
| Real references verified                                        | 100/100 (100.0%) | 100%   | yes |
| Fabricated references rejected (not_found or mismatch)          | 50/50 (100.0%)   | 100%   | yes |
| False acceptances (fabricated or mismatched marked verified)    | 0                | 0      | yes |
| Mismatched references detected as mismatch                      | 25/25 (100.0%)   | 100%   | yes |
| Unverifiable or errored items (provider failures; never a pass) | 0                | 0      | yes |

Fabricated items answered exactly `not_found`: 50/50.

| HTTP attempts (host, route, status) | Count |
| ----------------------------------- | ----- |
| api.crossref.org list 200           | 50    |
| api.crossref.org list 429           | 20    |
| api.crossref.org record 200         | 125   |
| api.crossref.org record 404         | 25    |
| api.crossref.org record 429         | 50    |

## Failing items (0)

None.
