import { Readable } from 'node:stream';

import type * as S3 from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStorage } from '../../src/storage';

const send = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
  ...(await importOriginal<typeof S3>()),
  S3Client: class {
    send = send;
  },
}));

const storage = () =>
  createStorage({
    region: 'us-east-1',
    bucket: 'test-bucket',
    accessKeyId: 'test-only-id',
    secretAccessKey: 'test-only-secret',
    forcePathStyle: true,
  });

afterEach(() => send.mockReset());

describe('bounded S3 reads', () => {
  it('reads an object with no Content-Length within the limit', async () => {
    const body = Readable.from([Buffer.from('ab'), Buffer.from('cd')]);
    send.mockResolvedValue({ Body: body });
    expect(await storage().getBytes('key', 4)).toEqual(Buffer.from('abcd'));
    expect(body.destroyed).toBe(true);
  });

  it.each([undefined, 1])('stops reading at the limit with Content-Length %s', async (length) => {
    let pulled = 0;
    const body = Readable.from(
      (function* () {
        for (let i = 0; i < 100; i++) {
          pulled++;
          yield Buffer.alloc(8);
        }
      })(),
      { highWaterMark: 1 },
    );
    send.mockResolvedValue({ Body: body, ContentLength: length });
    await expect(storage().getBytes('key', 4)).rejects.toMatchObject({ code: 'STORAGE_TOO_LARGE' });
    expect(pulled).toBeLessThan(100);
    expect(body.destroyed).toBe(true);
  });

  it('closes an object rejected by its declared size', async () => {
    const body = Readable.from([Buffer.from('private')]);
    send.mockResolvedValue({ Body: body, ContentLength: 7 });
    await expect(storage().getBytes('key', 4)).rejects.toMatchObject({ code: 'STORAGE_TOO_LARGE' });
    expect(body.destroyed).toBe(true);
  });

  it('maps a stream failure to a retryable stable code', async () => {
    const body = Readable.from(
      (function* () {
        yield Buffer.from('ok');
        throw new Error('private transport details');
      })(),
    );
    send.mockResolvedValue({ Body: body });
    await expect(storage().getBytes('key', 100)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'STORAGE_UNAVAILABLE',
    });
    expect(body.destroyed).toBe(true);
  });
});
