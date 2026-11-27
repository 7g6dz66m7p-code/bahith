#!/usr/bin/env python3
"""Write the staging secrets into the Vercel preview, without any value in clear.

  keygen:  uv run --with pynacl scripts/preview-env-sync.py keygen <private-key-file>
           -> prints the one-time public key for ops/preview-transfer.pub
  sync:    uv run --with pynacl scripts/preview-env-sync.py sync <private-key-file> <sealed.json>

`sync` decrypts in memory the values sealed by the "Staging preview secrets" workflow,
generates a staging-only BETTER_AUTH_SECRET when the preview has none, and upserts every
value as a Vercel "sensitive" variable of the preview branch only. The Vercel API token
comes from the environment (VERCEL_TOKEN, or a proxy that injects it). The private key
file is deleted at the end. Only names and HTTP statuses are printed.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = 'prj_1xspDGpGF7c0cf8XJvC1RLAWtHIY'  # bahith-preview
TEAM = 'team_Iv7IuZUmdrrkNwuR7mfeEskd'
BRANCH = 'feat/bahith-liquid-glass'
ALLOWED = {
    'DATABASE_URL', 'AUTH_DATABASE_URL', 'OPENAI_API_KEY', 'REDIS_URL',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM',
    'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
    'S3_FORCE_PATH_STYLE',
}


def vercel(method: str, path: str, body: object | None = None) -> tuple[int, dict]:
    cafile = os.environ.get('SSL_CERT_FILE') or (
        '/root/.ccr/ca-bundle.crt' if Path('/root/.ccr/ca-bundle.crt').exists() else None
    )
    request = urllib.request.Request(
        f'https://api.vercel.com{path}{"&" if "?" in path else "?"}teamId={TEAM}',
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            'Authorization': f"Bearer {os.environ.get('VERCEL_TOKEN', 'proxy-injected')}",
            'Content-Type': 'application/json',
        },
    )
    try:
        with urllib.request.urlopen(request, context=ssl.create_default_context(cafile=cafile), timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.load(error)
        except json.JSONDecodeError:
            return error.code, {}


def keygen(private_file: Path) -> None:
    from nacl.public import PrivateKey

    key = PrivateKey.generate()
    old = os.umask(0o077)
    try:
        private_file.write_bytes(bytes(key))
    finally:
        os.umask(old)
    print(base64.b64encode(bytes(key.public_key)).decode())


def sync(private_file: Path, sealed_file: Path) -> None:
    from nacl.public import PrivateKey, SealedBox

    payload = json.loads(sealed_file.read_text())
    box = SealedBox(PrivateKey(private_file.read_bytes()))
    if base64.b64encode(bytes(PrivateKey(private_file.read_bytes()).public_key)).decode() != payload['key']:
        sys.exit('error: sealed for another key')
    values = {}
    for name, sealed in payload['sealed'].items():
        if name not in ALLOWED:
            sys.exit(f'error: refusing unexpected name {name}')
        values[name] = box.decrypt(base64.b64decode(sealed)).decode()

    status, listing = vercel('GET', f'/v10/projects/{PROJECT}/env?gitBranch={BRANCH}')
    if status != 200:
        sys.exit(f'error: cannot read the preview variables (HTTP {status}); the token needs this team')
    existing = {env['key'] for env in listing.get('envs', [])}
    if 'BETTER_AUTH_SECRET' not in existing:
        values['BETTER_AUTH_SECRET'] = secrets.token_urlsafe(48)  # staging-only, new

    body = [
        {'key': name, 'value': value, 'type': 'sensitive', 'target': ['preview'], 'gitBranch': BRANCH}
        for name, value in sorted(values.items())
    ]
    status, result = vercel('POST', f'/v10/projects/{PROJECT}/env?upsert=true', body)
    values.clear()
    body.clear()
    created = sorted(env['key'] for env in result.get('created', []))
    failed = [str(item.get('error', {}).get('code', 'error')) for item in result.get('failed', [])]
    print(f'Vercel upsert: HTTP {status}; written: {", ".join(created) or "none"}; failed: {len(failed)} {failed}')
    private_file.unlink(missing_ok=True)
    print('one-time private key deleted')
    if status not in (200, 201) or failed:
        sys.exit(1)


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'keygen':
        keygen(Path(sys.argv[2]))
    elif len(sys.argv) >= 4 and sys.argv[1] == 'sync':
        sync(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        sys.exit(__doc__)
