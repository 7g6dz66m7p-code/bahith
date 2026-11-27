#!/usr/bin/env bash
# The researcher journey against the protected preview, through a TEMPORARY Protection
# Bypass for Automation: generated here (random, masked), used for this run only, and
# revoked on exit whatever happens. Deployment Protection itself is never changed.
# Prints step results, ids and status codes only. CI only.
set -euo pipefail

: "${VERCEL_TOKEN:?}" "${VERCEL_TEAM_ID:?}" "${VERCEL_PROJECT_ID:?}" "${PREVIEW_URL:?}"
API="${VERCEL_API:-https://api.vercel.com}"
q="teamId=$VERCEL_TEAM_ID"
vercel() {
  curl -fsS --retry 3 --retry-delay 2 --max-time 60 -X "$1" \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$VERCEL_TOKEN") \
    -H 'content-type: application/json' "$API$2" "${@:3}"
}

VERCEL_AUTOMATION_BYPASS_SECRET=$(openssl rand -hex 16)
echo "::add-mask::$VERCEL_AUTOMATION_BYPASS_SECRET"
export VERCEL_AUTOMATION_BYPASS_SECRET
revoke() {
  jq -n '{revoke: {secret: env.VERCEL_AUTOMATION_BYPASS_SECRET, regenerate: false}}' |
    vercel PATCH "/v1/projects/$VERCEL_PROJECT_ID/protection-bypass?$q" --data @- >/dev/null &&
    echo "temporary bypass revoked" || echo "::error::could not revoke the temporary bypass"
}
jq -n --arg note "bahith staging CI run ${GITHUB_RUN_ID:-local} (temporary)" \
  '{generate: {secret: env.VERCEL_AUTOMATION_BYPASS_SECRET, note: $note}}' |
  vercel PATCH "/v1/projects/$VERCEL_PROJECT_ID/protection-bypass?$q" --data @- >/dev/null
trap revoke EXIT
echo "temporary bypass created"

health=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' \
  --config <(printf 'header = "x-vercel-protection-bypass: %s"\n' "$VERCEL_AUTOMATION_BYPASS_SECRET") \
  "$PREVIEW_URL/api/health")
echo "health: HTTP $health"
[[ "$health" == "200" ]] || { echo "::error::preview health is not 200"; exit 1; }

out="$RUNNER_TEMP/journey.json"
LOAD_BASE_URL="$PREVIEW_URL" pnpm --filter @bahith/web exec tsx load/prepare.ts >"$out"
echo "PASS sign-up, e-mail verification (Resend), sign-in, project, upload, processing"
pnpm --filter @bahith/web exec tsx load/staging-journey.ts "$out"
rm -f "$out"
