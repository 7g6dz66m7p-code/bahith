#!/usr/bin/env bash
# Redeploys the preview branch of bahith-preview from git (so it picks up the variables
# just written), waits until it is READY, waits for any other build of the same branch to
# settle, then makes sure the stable branch URL points to this deployment. CI only.
# Prints ids, states and URLs only. Writes `deployment=<id>` to GITHUB_OUTPUT.
set -euo pipefail

: "${VERCEL_TOKEN:?}" "${VERCEL_TEAM_ID:?}" "${VERCEL_PROJECT_ID:?}" "${PREVIEW_BRANCH:?}"
: "${PREVIEW_URL:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}"
[[ "$PREVIEW_BRANCH" != "main" ]] || { echo "::error::refusing the production branch"; exit 1; }
API="${VERCEL_API:-https://api.vercel.com}"
q="teamId=$VERCEL_TEAM_ID"
vercel() {
  curl -fsS --retry 3 --retry-delay 2 --max-time 60 -X "$1" \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$VERCEL_TOKEN") \
    -H 'content-type: application/json' "$API$2" "${@:3}"
}

id=$(jq -n --arg project "$VERCEL_PROJECT_ID" --arg repo "$GITHUB_REPOSITORY" \
  --arg ref "$PREVIEW_BRANCH" --arg sha "$GITHUB_SHA" \
  '{name: "bahith-preview", project: $project,
    gitSource: {type: "github", org: ($repo | split("/")[0]), repo: ($repo | split("/")[1]),
                ref: $ref, sha: $sha}}' |
  vercel POST "/v13/deployments?$q" --data @- | jq -r .id)
echo "deployment: $id (preview, $PREVIEW_BRANCH@${GITHUB_SHA:0:7})"

state=""
for _ in $(seq 1 120); do
  json=$(vercel GET "/v13/deployments/$id?$q")
  state=$(jq -r .readyState <<<"$json")
  target=$(jq -r '.target // "preview"' <<<"$json")
  [[ "$target" != "production" ]] || { echo "::error::deployment is not a preview"; exit 1; }
  case "$state" in READY | ERROR | CANCELED) break ;; esac
  sleep 10
done
echo "state: $state"
[[ "$state" == "READY" ]] || { echo "::error::deployment did not become READY"; exit 1; }

# The push that started this run also built the branch; let that finish so it cannot take
# the branch URL after us.
for _ in $(seq 1 60); do
  busy=$(vercel GET "/v6/deployments?projectId=$VERCEL_PROJECT_ID&target=preview&limit=20&$q" |
    jq --arg b "$PREVIEW_BRANCH" --arg id "$id" '[.deployments[]
      | select(.meta.githubCommitRef == $b and .uid != $id)
      | select(.state == "BUILDING" or .state == "QUEUED" or .state == "INITIALIZING")] | length')
  [[ "$busy" == "0" ]] && break
  sleep 10
done

host=${PREVIEW_URL#https://}
current=$(vercel GET "/v4/aliases/$host?projectId=$VERCEL_PROJECT_ID&$q" | jq -r '.deploymentId // ""' || true)
if [[ "$current" != "$id" ]]; then
  jq -n --arg alias "$host" '{alias: $alias}' |
    vercel POST "/v2/deployments/$id/aliases?$q" --data @- >/dev/null
  echo "branch URL reassigned to $id"
fi
echo "branch URL: $PREVIEW_URL -> $id"
echo "deployment=$id" >>"$GITHUB_OUTPUT"
