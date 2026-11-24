import { describe, expect, it, vi } from 'vitest';

import { readUploadForm, UploadBodyTooLargeError } from '@/server/upload-body';

async function multipart() {
  const form = new FormData();
  form.append('file', new File(['research source'], 'مصدر.txt', { type: 'text/plain' }));
  const request = new Request('https://bahith.example.test/upload', {
    method: 'POST',
    body: form,
  });
  return {
    bytes: new Uint8Array(await request.arrayBuffer()),
    contentType: request.headers.get('content-type') ?? '',
  };
}

function streamedRequest(bytes: Uint8Array, contentType: string, declared?: string) {
  let position = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (position === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(position + 16, bytes.length);
        controller.enqueue(bytes.slice(position, end));
        position = end;
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const headers = new Headers({ 'content-type': contentType });
  if (declared !== undefined) headers.set('content-length', declared);
  return {
    request: new Request('https://bahith.example.test/upload', {
      method: 'POST',
      body,
      headers,
      ...{ duplex: 'half' },
    }),
    cancel,
    received: () => position,
  };
}

describe('bounded multipart upload', () => {
  it.each([undefined, '1'])(
    'parses within the byte limit with Content-Length %s',
    async (declared) => {
      const { bytes, contentType } = await multipart();
      const { request } = streamedRequest(bytes, contentType, declared);
      const result = await readUploadForm(request, bytes.length);
      const file = result?.get('file');
      expect(file).toBeInstanceOf(File);
      expect(await (file as File).text()).toBe('research source');
      expect((file as File).name).toBe('مصدر.txt');
    },
  );

  it.each([undefined, '1'])(
    'stops oversized actual bytes with Content-Length %s',
    async (declared) => {
      const { bytes, contentType } = await multipart();
      const { request, cancel, received } = streamedRequest(bytes, contentType, declared);
      await expect(readUploadForm(request, 32)).rejects.toBeInstanceOf(UploadBodyTooLargeError);
      expect(cancel).toHaveBeenCalledOnce();
      expect(received()).toBeLessThan(bytes.length);
      expect(received()).toBeLessThanOrEqual(48);
    },
  );

  it('rejects excessive declared length before consuming the body', async () => {
    const { bytes, contentType } = await multipart();
    const { request, cancel, received } = streamedRequest(
      bytes,
      contentType,
      String(bytes.length + 1),
    );
    await expect(readUploadForm(request, bytes.length)).rejects.toBeInstanceOf(
      UploadBodyTooLargeError,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(received()).toBe(0);
  });

  it('releases the reader after malformed multipart', async () => {
    const { bytes } = await multipart();
    const { request, received } = streamedRequest(bytes, 'multipart/form-data');
    expect(await readUploadForm(request, bytes.length)).toBeNull();
    // Undici consumes this body before discovering the missing boundary.
    expect(received()).toBe(bytes.length);
    expect(request.body?.locked).toBe(false);
  });
});
