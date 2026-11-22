# Fabricated-reference detection — live run

Run live (providers: **crossref+openalex**) from 2026-11-22T06:04:57.034Z to 2026-11-22T06:06:21.512Z (Node v22.23.4). Dataset generated 2026-11-21T13:10:44.778Z. No response cache.

| Kind       | Total | verified | mismatch | not_found | unverifiable | error | pass |
| ---------- | ----- | -------- | -------- | --------- | ------------ | ----- | ---- |
| real       | 100   | 100      | 0        | 0         | 0            | 0     | 100  |
| fabricated | 50    | 0        | 0        | 25        | 25           | 0     | 25   |
| mismatched | 25    | 0        | 25       | 0         | 0            | 0     | 25   |

| Metric                                                          | Value            | Target | Met |
| --------------------------------------------------------------- | ---------------- | ------ | --- |
| Real references verified                                        | 100/100 (100.0%) | 100%   | yes |
| Fabricated references rejected (not_found or mismatch)          | 25/50 (50.0%)    | 100%   | NO  |
| False acceptances (fabricated or mismatched marked verified)    | 0                | 0      | yes |
| Mismatched references detected as mismatch                      | 25/25 (100.0%)   | 100%   | yes |
| Unverifiable or errored items (provider failures; never a pass) | 25               | 0      | NO  |

Fabricated items answered exactly `not_found`: 25/50.

| HTTP attempts (host, status) | Count |
| ---------------------------- | ----- |
| api.crossref.org 200         | 174   |
| api.crossref.org 404         | 25    |
| api.crossref.org 429         | 69    |
| api.openalex.org 404         | 25    |
| api.openalex.org 429         | 50    |

## Failing items (25)

- `fab-title-01` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-02` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-03` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-04` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-05` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-06` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-07` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-08` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-09` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-10` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-11` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-12` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-13` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-14` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-15` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-16` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-17` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-18` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-19` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-20` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-21` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-22` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-23` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-24` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
- `fab-title-25` (fabricated): expected not_found, got **unverifiable**; reasons: PROVIDER_UNAVAILABLE
