# Isolated production readiness checks

These checks run the production Next.js build against disposable Postgres 16 + pgvector,
Redis, MinIO and Mailpit containers and the real Python extraction and Node ingestion workers.
They refuse non-loopback targets. They never read production data.

Run the existing lint, unit, integration and browser suites first. Do not build in parallel
with Playwright: both use `apps/web/.next`.

```sh
# Terminal 1: leaves the isolated production server running; Ctrl+C cleans its services.
BAHITH_TEST_PORT=3200 pnpm --filter @bahith/db exec tsx ../../apps/web/e2e/server.ts

# Terminal 2: creates 50 actual accounts, verifies their real local SMTP tokens, creates
# a personal project per account, uploads synthetic TXT and waits for real ingestion.
pnpm --filter @bahith/web exec tsx e2e/readiness-fixtures.ts

# Install k6 separately. The fixture file contains temporary session cookies and must
# remain ignored; it is written with mode 0600. Summary output contains no sessions.
BAHITH_LOAD_FIXTURES="$PWD/apps/web/.next/readiness-users.json" \
  k6 run --summary-export apps/web/test-results/readiness/k6-summary.json \
  scripts/readiness/load.js

# Install OWASP ZAP 2.17.0 + Java 17 or later separately. This starts a loopback-only
# ZAP daemon, adds one synthetic user cookie restricted to the local app, visits
# public and authenticated pages, spiders, drains passive scanning, sanitizes alerts,
# writes test-results/readiness/zap-baseline.json, and shuts ZAP down.
ZAP_JAR=/absolute/path/zap-2.17.0.jar node scripts/readiness/zap.mjs
```

The load scenario is 50 concurrent, distinct verified users for 30 seconds. Every iteration
asserts project ownership, actual lexical evidence and cross-user denial. The gates are zero
failed requests, 100% assertions, and p95 below eight seconds for project and evidence APIs.
They do **not** measure model first-token latency, semantic recall or scientific accuracy;
no model is invoked and each test workspace contains one small synthetic document.
Fixture setup resets authentication rate-limit rows only between identities, exactly like
browser-test setup; the measured scenario does not change rate-limit policy or rows.

ZAP is an authenticated **passive baseline**, not a proof that all vulnerabilities are absent.
Medium and High findings fail its gate and must be investigated. Low/informational findings
remain in the output. The localhost HTTP transport cannot establish production TLS/HSTS or
Secure-cookie behavior; use a staging HTTPS environment for that gate. Active injection,
authentication abuse and authorization are covered separately by the repository regression
and integration suites; a full staging active scan remains necessary before launch.

Never commit `.next`, `test-results`, fixture sessions or raw ZAP state. Preserve the exact
tool versions, resource limits, request counts, latency percentiles and remaining findings
in the development report. A failing gate remains a failure until a genuine fix is verified.
