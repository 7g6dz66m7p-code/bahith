import { createHash, randomBytes } from 'node:crypto';

import { createStorage, parseStorageConfig } from '../storage';

/**
 * tsx src/cli/storage-check.ts — end-to-end check of the configured S3/R2 bucket with
 * synthetic objects only: upload (server-verified SHA-256), read back byte-for-byte,
 * stream, anonymous access refused, delete, and gone after delete. It refuses any
 * bucket whose name does not contain "staging", so production files are never touched.
 * Prints results without credentials.
 */
const config = parseStorageConfig(process.env);
if (!config.bucket.includes('staging')) {
  process.stderr.write(`refusing: bucket "${config.bucket}" is not a staging bucket\n`);
  process.exit(2);
}
const storage = createStorage(config);
const run = crypto.randomUUID();
const results: Record<string, string> = { bucket: config.bucket };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const objects = [
  {
    key: `storage-check/${run}/binary.bin`,
    bytes: new Uint8Array(randomBytes(256 * 1024)),
    type: 'application/octet-stream',
  },
  {
    key: `storage-check/${run}/arabic.txt`,
    bytes: new TextEncoder().encode('نص تجريبي اصطناعي للتحقق من التخزين — synthetic check\n'),
    type: 'text/plain; charset=utf-8',
  },
];
let failed = false;
try {
  for (const object of objects) {
    const name = object.key.split('/').pop() ?? '';
    await storage.put(object.key, object.bytes, object.type);
    const back = await storage.getBytes(object.key, 1024 * 1024);
    results[`${name}: round trip`] = sha(back) === sha(object.bytes) ? 'ok' : 'MISMATCH';
    const stream = await storage.getStream(object.key);
    let streamed = 0;
    for await (const chunk of stream.body) streamed += (chunk as Buffer).length;
    results[`${name}: stream`] = streamed === object.bytes.length ? 'ok' : 'MISMATCH';
    if (config.endpoint !== undefined) {
      const url = new URL(
        `${config.bucket}/${object.key}`,
        `${config.endpoint.replace(/\/$/u, '')}/`,
      );
      const anonymous = await fetch(url);
      results[`${name}: anonymous GET`] = [400, 401, 403].includes(anonymous.status)
        ? `refused (${String(anonymous.status)})`
        : `EXPOSED (${String(anonymous.status)})`;
    }
  }
} finally {
  for (const object of objects) {
    const name = object.key.split('/').pop() ?? '';
    await storage.delete(object.key);
    try {
      await storage.getBytes(object.key, 1024);
      results[`${name}: after delete`] = 'STILL PRESENT';
    } catch {
      results[`${name}: after delete`] = 'gone';
    }
  }
}
for (const [check, value] of Object.entries(results)) {
  process.stdout.write(`${check}: ${value}\n`);
  if (/MISMATCH|EXPOSED|STILL PRESENT/u.test(value)) failed = true;
}
process.exit(failed ? 1 : 0);
