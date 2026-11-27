#!/usr/bin/env python3
"""Create the staging R2 credential and store it as GitHub environment secrets. CI only.

Runs in GitHub Actions (environment "staging") with two short-lived, user-supplied
secrets: CLOUDFLARE_BOOTSTRAP_TOKEN (User > API Tokens > Edit, Account Settings > Read)
and GH_SECRETS_TOKEN (fine-grained, this repository only, Environments: write).

  1. Skips everything if R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY already
     exist in the environment (existing secrets are reused, never replaced).
  2. Creates BAHITH-Staging-R2-CI: "Workers R2 Storage Bucket Item Write" on the single
     bucket bahith-staging-files (object read + write; no bucket admin, no other bucket).
  3. Derives the S3 credential (Access Key ID = token id, Secret = SHA-256 of its value)
     and proves it: write, read back, delete one synthetic object in that bucket.
  4. Seals each value to the environment's public key (libsodium sealed box, GitHub's
     official scheme) and PUTs it through the GitHub API. Values exist only in memory.
  5. Revokes the bootstrap token and deletes both bootstrap secrets from the environment.

Prints names, statuses and counts only.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

CF = os.environ.get("CF_API", "https://api.cloudflare.com/client/v4")
GH = os.environ.get("GH_API", "https://api.github.com")
BUCKET = "bahith-staging-files"
TOKEN_NAME = "BAHITH-Staging-R2-CI"
PERMISSION = "Workers R2 Storage Bucket Item Write"
NAMES = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
ENVIRONMENT = "staging"


def fail(message: str) -> None:
    print(f"::error::{message}")
    sys.exit(1)


def call(url: str, token: str, method: str = "GET", body: dict | None = None,
         github: bool = False) -> tuple[int, dict]:
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if github:
        headers |= {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    request = urllib.request.Request(
        url, method=method, headers=headers,
        data=None if body is None else json.dumps(body).encode(),
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return error.code, {}


def cf_errors(payload: dict) -> str:
    return "; ".join(f"{e.get('code')}: {e.get('message')}" for e in payload.get("errors", [])) or "no detail"


def main() -> None:
    cf_token = os.environ.get("CLOUDFLARE_BOOTSTRAP_TOKEN", "")
    gh_token = os.environ.get("GH_SECRETS_TOKEN", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not gh_token:
        fail("GH_SECRETS_TOKEN is not set in environment staging")
    env_api = f"{GH}/repos/{repo}/environments/{ENVIRONMENT}/secrets"

    present = [n for n in NAMES if call(f"{env_api}/{n}", gh_token, github=True)[0] == 200]
    if len(present) == len(NAMES):
        print("R2 secrets already present in staging: reused, nothing created")
        return
    print(f"R2 secrets present: {len(present)}/{len(NAMES)}; creating the credential")
    if not cf_token:
        fail("CLOUDFLARE_BOOTSTRAP_TOKEN is not set in environment staging")

    status, accounts = call(f"{CF}/accounts?per_page=50", cf_token)
    if status != 200 or not accounts.get("success"):
        fail(f"cannot list accounts (HTTP {status}: {cf_errors(accounts)}); needs Account Settings: Read")
    if len(accounts["result"]) != 1:
        fail(f"expected exactly one Cloudflare account, the token sees {len(accounts['result'])}")
    account = accounts["result"][0]["id"]

    status, verify = call(f"{CF}/user/tokens/verify", cf_token)
    if status != 200 or not verify.get("success"):
        fail(f"bootstrap token not valid (HTTP {status}: {cf_errors(verify)})")
    bootstrap_id = verify["result"]["id"]

    status, groups = call(f"{CF}/user/tokens/permission_groups", cf_token)
    if status != 200 or not groups.get("success"):
        fail(f"cannot read permission groups (HTTP {status}); needs User > API Tokens: Edit")
    group = next((g for g in groups["result"] if g.get("name") == PERMISSION), None)
    if group is None:
        fail(f'permission group "{PERMISSION}" is not available')

    status, existing = call(f"{CF}/user/tokens?per_page=50", cf_token)
    for token in existing.get("result", []) if status == 200 else []:
        if token.get("name") == TOKEN_NAME:
            print(f"deleted earlier {TOKEN_NAME}: HTTP {call(f'{CF}/user/tokens/{token['id']}', cf_token, 'DELETE')[0]}")

    resource = f"com.cloudflare.edge.r2.bucket.{account}_default_{BUCKET}"
    status, created = call(f"{CF}/user/tokens", cf_token, "POST", {
        "name": TOKEN_NAME,
        "policies": [{"effect": "allow", "resources": {resource: "*"},
                      "permission_groups": [{"id": group["id"]}]}],
    })
    if status != 200 or not created.get("success"):
        fail(f"token not created (HTTP {status}: {cf_errors(created)})")
    scope = list(created["result"]["policies"][0]["resources"].keys())
    if scope != [resource]:
        fail("the created token is not limited to the staging bucket")
    print(f"created {TOKEN_NAME}: {PERMISSION}, bucket {BUCKET} only")
    values = {
        "R2_ACCOUNT_ID": account,
        "R2_ACCESS_KEY_ID": created["result"]["id"],
        "R2_SECRET_ACCESS_KEY": hashlib.sha256(created["result"]["value"].encode()).hexdigest(),
    }
    del created
    for value in values.values():
        print(f"::add-mask::{value}")

    import boto3  # noqa: PLC0415
    from botocore.config import Config  # noqa: PLC0415
    from nacl.public import PublicKey, SealedBox  # noqa: PLC0415

    s3 = boto3.client(
        "s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com", region_name="auto",
        aws_access_key_id=values["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=values["R2_SECRET_ACCESS_KEY"],
        config=Config(request_checksum_calculation="when_required",
                      response_checksum_validation="when_required"),
    )
    key = f"storage-check/provision-{uuid.uuid4()}.txt"
    body = b"synthetic provisioning check\n"
    for attempt in range(12):
        try:
            s3.put_object(Bucket=BUCKET, Key=key, Body=body)
            break
        except Exception as error:  # noqa: BLE001 (class name only)
            if attempt == 11:
                fail(f"the new credential cannot write to {BUCKET}: {type(error).__name__}")
            time.sleep(5)
    back = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
    s3.delete_object(Bucket=BUCKET, Key=key)
    if back != body:
        fail("read-back mismatch")
    print("R2 check with the new credential: write ok, read ok, delete ok")

    status, public = call(f"{env_api}/public-key", gh_token, github=True)
    if status != 200:
        fail(f"cannot read the staging public key (HTTP {status}); needs Environments: write")
    box = SealedBox(PublicKey(base64.b64decode(public["key"])))
    for name in NAMES:
        sealed = base64.b64encode(box.encrypt(values[name].encode())).decode()
        status, _ = call(f"{env_api}/{name}", gh_token, "PUT",
                         {"encrypted_value": sealed, "key_id": public["key_id"]}, github=True)
        if status not in (201, 204):
            fail(f"{name} not stored (HTTP {status})")
        print(f"stored in staging: {name}")
    values.clear()

    print(f"bootstrap token revoked: HTTP {call(f'{CF}/user/tokens/{bootstrap_id}', cf_token, 'DELETE')[0]}")
    for name in ("CLOUDFLARE_BOOTSTRAP_TOKEN", "GH_SECRETS_TOKEN"):
        print(f"removed from staging: {name} (HTTP {call(f'{env_api}/{name}', gh_token, 'DELETE', github=True)[0]})")


if __name__ == "__main__":
    main()
