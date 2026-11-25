#!/usr/bin/env python3
"""Issue the staging R2 credential and seal it for GitHub, without any value in clear.

Run where a short-lived Cloudflare *bootstrap* token is supplied by the environment
(header injected by a proxy, or CLOUDFLARE_BOOTSTRAP_TOKEN). The bootstrap token needs
only: User > API Tokens > Edit (or Account > Account API Tokens > Edit) and
Account > Account Settings > Read.

  uv run --with pynacl --with boto3 scripts/staging-r2-bootstrap.py \
      --key-id <staging key_id> --public-key <staging public key> [--dry-run]

What it does:
  1. finds the one account and the "Workers R2 Storage Bucket Item Write" permission;
  2. creates the token BAHITH-Staging-R2-CI, limited to the bucket bahith-staging-files
     (any earlier token with that exact name is deleted first);
  3. derives the S3 credential (Access Key ID = token id, Secret = SHA-256 of its value),
     proves it can write, read and delete one synthetic object in that bucket;
  4. seals R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY to the staging
     environment's public key (libsodium sealed box) into ops/staging-secrets.sealed.json;
  5. revokes the bootstrap token itself (unless --keep-bootstrap).
Only names, statuses and counts are printed. Production buckets are never addressed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import UTC, datetime
from pathlib import Path

API = "https://api.cloudflare.com/client/v4"
BUCKET = "bahith-staging-files"
TOKEN_NAME = "BAHITH-Staging-R2-CI"
PERMISSION = "Workers R2 Storage Bucket Item Write"
SECRET_NAMES = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")


class Cloudflare:
    def __init__(self) -> None:
        # With a proxy that injects the real token, any placeholder value works.
        self.token = os.environ.get("CLOUDFLARE_BOOTSTRAP_TOKEN", "proxy-injected")
        cafile = os.environ.get("SSL_CERT_FILE") or (
            "/root/.ccr/ca-bundle.crt" if Path("/root/.ccr/ca-bundle.crt").exists() else None
        )
        self.context = ssl.create_default_context(cafile=cafile)

    def call(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        request = urllib.request.Request(
            f"{API}{path}",
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, context=self.context, timeout=30) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.load(error)
            except json.JSONDecodeError:
                return error.code, {}


def errors(payload: dict) -> str:
    return "; ".join(
        f"{e.get('code')}: {e.get('message')}" for e in payload.get("errors", [])
    ) or "no detail"


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--key-id", help="staging environment public key id")
    parser.add_argument("--public-key", help="staging environment public key (base64)")
    parser.add_argument("--out", default="ops/staging-secrets.sealed.json")
    parser.add_argument("--dry-run", action="store_true", help="check permissions only")
    parser.add_argument("--keep-bootstrap", action="store_true")
    args = parser.parse_args()
    if not args.dry_run and not (args.key_id and args.public_key):
        fail("--key-id and --public-key are required (or --dry-run)")

    cf = Cloudflare()

    # Which kind of bootstrap token is it, and which account?
    status, accounts = cf.call("GET", "/accounts?per_page=50")
    if status != 200 or not accounts.get("success"):
        fail(f"cannot list accounts (HTTP {status}: {errors(accounts)}); the bootstrap token needs Account Settings: Read")
    if len(accounts["result"]) != 1:
        fail(f"expected exactly one account, the token sees {len(accounts['result'])}")
    account = accounts["result"][0]["id"]
    print("account: found (1)")

    status, verify = cf.call("GET", "/user/tokens/verify")
    if status == 200 and verify.get("success"):
        base = "/user/tokens"
    else:
        status, verify = cf.call("GET", f"/accounts/{account}/tokens/verify")
        if status != 200 or not verify.get("success"):
            fail(f"bootstrap token not valid (HTTP {status}: {errors(verify)})")
        base = f"/accounts/{account}/tokens"
    bootstrap_id = verify["result"]["id"]
    print(f"bootstrap token: valid ({'user' if base == '/user/tokens' else 'account'}-owned)")

    status, groups = cf.call("GET", f"{base}/permission_groups")
    if status != 200 or not groups.get("success"):
        fail(f"cannot read permission groups (HTTP {status}: {errors(groups)}); the bootstrap token needs API Tokens: Edit")
    group = next((g for g in groups["result"] if g.get("name") == PERMISSION), None)
    if group is None:
        fail(f'permission group "{PERMISSION}" not available to this token')
    print(f'permission group: "{PERMISSION}" available')

    status, existing = cf.call("GET", f"{base}?per_page=50")
    if status != 200 or not existing.get("success"):
        fail(f"cannot list tokens (HTTP {status}: {errors(existing)}); the bootstrap token needs API Tokens: Edit")
    earlier = [t for t in existing["result"] if t.get("name") == TOKEN_NAME]
    print(f"earlier {TOKEN_NAME} tokens: {len(earlier)}")
    if args.dry_run:
        print("dry run: nothing created")
        return

    from nacl.public import PublicKey, SealedBox  # noqa: PLC0415 (only for the real run)
    import boto3  # noqa: PLC0415
    from botocore.config import Config  # noqa: PLC0415

    for token in earlier:
        status, _ = cf.call("DELETE", f"{base}/{token['id']}")
        print(f"deleted earlier {TOKEN_NAME}: HTTP {status}")

    resource = f"com.cloudflare.edge.r2.bucket.{account}_default_{BUCKET}"
    status, created = cf.call(
        "POST",
        base,
        {
            "name": TOKEN_NAME,
            "policies": [
                {
                    "effect": "allow",
                    "resources": {resource: "*"},
                    "permission_groups": [{"id": group["id"]}],
                }
            ],
        },
    )
    if status != 200 or not created.get("success"):
        fail(f"token not created (HTTP {status}: {errors(created)})")
    scope = list(created["result"]["policies"][0]["resources"].keys())
    print(f"created {TOKEN_NAME}: scope = {len(scope)} bucket ({BUCKET} only: {scope == [resource]})")
    values = {
        "R2_ACCOUNT_ID": account,
        "R2_ACCESS_KEY_ID": created["result"]["id"],
        "R2_SECRET_ACCESS_KEY": hashlib.sha256(created["result"]["value"].encode()).hexdigest(),
    }
    del created

    # Prove the credential: write, read back, delete one synthetic object (new tokens can
    # take a few seconds to propagate).
    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=values["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=values["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )
    key = f"storage-check/bootstrap-{uuid.uuid4()}.txt"
    body = b"synthetic bootstrap check\n"
    for attempt in range(12):
        try:
            s3.put_object(Bucket=BUCKET, Key=key, Body=body)
            break
        except Exception as error:  # noqa: BLE001 (report the class only)
            if attempt == 11:
                fail(f"the new credential cannot write to {BUCKET}: {type(error).__name__}")
            time.sleep(5)
    back = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
    s3.delete_object(Bucket=BUCKET, Key=key)
    print(f"R2 check with the new credential: write ok, read {'ok' if back == body else 'MISMATCH'}, delete ok")
    if back != body:
        sys.exit(1)

    box = SealedBox(PublicKey(base64.b64decode(args.public_key)))
    sealed = {
        "key_id": args.key_id,
        "sealed_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "token": {"name": TOKEN_NAME, "bucket": BUCKET, "permission": PERMISSION},
        "secrets": {
            name: base64.b64encode(box.encrypt(values[name].encode())).decode()
            for name in SECRET_NAMES
        },
    }
    values.clear()
    Path(args.out).write_text(json.dumps(sealed, indent=2) + "\n")
    print(f"sealed {len(SECRET_NAMES)} secrets to the staging public key -> {args.out}")

    if not args.keep_bootstrap:
        status, _ = cf.call("DELETE", f"{base}/{bootstrap_id}")
        print(f"bootstrap token revoked: HTTP {status}")


if __name__ == "__main__":
    main()
