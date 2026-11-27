#!/usr/bin/env bash
# Direct GitHub Actions -> Vercel transfer of the staging configuration for ONE preview
# branch of the bahith-preview project. CI only (environment "staging").
#
# - Values are read from this process's environment (GitHub secrets) and sent straight to
#   the Vercel API over HTTPS. They never appear in argv, in a log, in a file or artifact:
#   the JSON body is built by jq from $ENV and piped to curl; the token goes in a curl
#   config read from a process substitution (bash builtin printf, so not in argv either).
# - Secret values are stored as type "sensitive" (write-only in Vercel); non-secret
#   settings as "plain". Every variable is scoped to target "preview" + this git branch,
#   so production and other previews are untouched.
# - BETTER_AUTH_SECRET: a separate staging secret is generated here only when the branch
#   has none yet; it then lives only in Vercel (sensitive, never readable back).
# - A name whose value is absent is skipped and reported by NAME only.
set -euo pipefail

: "${VERCEL_TOKEN:?VERCEL_TOKEN is not set in environment staging}"
: "${VERCEL_TEAM_ID:?}" "${VERCEL_PROJECT_ID:?}" "${PREVIEW_BRANCH:?}"
API="${VERCEL_API:-https://api.vercel.com}"
[[ "$PREVIEW_BRANCH" != "main" ]] || { echo "::error::refusing the production branch"; exit 1; }

vercel() { # method path [body on stdin]
  curl -fsS --retry 3 --retry-delay 2 --max-time 60 -X "$1" \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$VERCEL_TOKEN") \
    -H 'content-type: application/json' "$API$2" "${@:3}"
}
q="teamId=$VERCEL_TEAM_ID"

# Confirm the token reaches exactly this project before writing anything.
name=$(vercel GET "/v9/projects/$VERCEL_PROJECT_ID?$q" | jq -r .name)
[[ "$name" == "bahith-preview" ]] || { echo "::error::unexpected project"; exit 1; }
echo "project: $name, branch: $PREVIEW_BRANCH (target preview only)"

upsert() { # NAME TYPE (value from the environment variable of the same name)
  local key=$1 type=$2
  if [[ -z "${!key:-}" ]]; then
    echo "skipped (no value): $key"
    return 0
  fi
  KEY=$key TYPE=$type jq -n --arg branch "$PREVIEW_BRANCH" \
    '{key: env.KEY, value: env[env.KEY], type: env.TYPE, target: ["preview"], gitBranch: $branch}' |
    vercel POST "/v10/projects/$VERCEL_PROJECT_ID/env?upsert=true&$q" --data @- >/dev/null
  echo "set ($type): $key"
}

existing=$(vercel GET "/v10/projects/$VERCEL_PROJECT_ID/env?gitBranch=$PREVIEW_BRANCH&$q" |
  jq -r --arg b "$PREVIEW_BRANCH" '.envs[] | select((.target // []) | index("preview"))
    | select(.gitBranch == $b) | .key')
if grep -qx BETTER_AUTH_SECRET <<<"$existing"; then
  echo "kept (already set): BETTER_AUTH_SECRET"
  unset BETTER_AUTH_SECRET
else
  BETTER_AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
  echo "::add-mask::$BETTER_AUTH_SECRET"
  export BETTER_AUTH_SECRET
fi

for key in DATABASE_URL AUTH_DATABASE_URL REDIS_URL OPENAI_API_KEY SMTP_PASSWORD \
  S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY BETTER_AUTH_SECRET; do
  upsert "$key" sensitive
done
for key in BETTER_AUTH_URL SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_FROM \
  S3_REGION S3_BUCKET S3_FORCE_PATH_STYLE; do
  upsert "$key" plain
done
