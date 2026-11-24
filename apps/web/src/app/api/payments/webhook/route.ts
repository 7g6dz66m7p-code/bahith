import { apiError } from '@/server/api';
import { handlePaymentWebhook } from '@/server/billing';

const MAX_WEBHOOK_BYTES = 64 * 1024;

/**
 * Provider → BAHITH payment notifications. Authenticated by the provider's signature (not
 * by session or Origin); answers 503 while payments are disabled, so nothing is applied.
 */
export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES) {
      return Response.json({ code: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
    }
    const outcome = await handlePaymentWebhook(rawBody, request.headers);
    if (outcome === 'disabled')
      return Response.json({ code: 'PAYMENTS_DISABLED' }, { status: 503 });
    if (outcome === 'invalid_signature') {
      return Response.json({ code: 'INVALID_SIGNATURE' }, { status: 401 });
    }
    return Response.json({ received: true });
  } catch (error) {
    return apiError(error);
  }
}
