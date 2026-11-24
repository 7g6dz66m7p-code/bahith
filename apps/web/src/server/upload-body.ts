/** Raised before the multipart parser can consume more than the request budget. */
export class UploadBodyTooLargeError extends Error {
  constructor() {
    super('UPLOAD_TOO_LARGE');
    this.name = 'UploadBodyTooLargeError';
  }
}

/**
 * Bound the bytes delivered to the multipart parser. Content-Length is only an
 * early rejection hint: HTTP/2, chunked uploads and untrusted clients may omit it
 * or claim a smaller value. The file's own 50 MB limit is checked after parsing.
 */
export async function readUploadForm(request: Request, maxBytes: number): Promise<FormData | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new UploadBodyTooLargeError();
  }
  const reader = request.body?.getReader();
  if (reader === undefined) return null;
  let received = 0;
  const state = { tooLarge: false };
  const bounded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        received += next.value.byteLength;
        if (received > maxBytes) {
          state.tooLarge = true;
          controller.error(new UploadBodyTooLargeError());
          await reader.cancel().catch(() => undefined);
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  });
  try {
    // Forward only the media type; a false Content-Length must not control parsing.
    return await new Response(bounded, {
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
    }).formData();
  } catch {
    if (state.tooLarge) throw new UploadBodyTooLargeError();
    return null;
  } finally {
    // Also stop malformed multipart streams and disconnected clients.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
