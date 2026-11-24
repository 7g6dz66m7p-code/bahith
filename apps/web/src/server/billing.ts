import { createHmac, timingSafeEqual } from 'node:crypto';

import type { PendingPayment, VerifiedPaymentEvent } from '@bahith/db';
import {
  applyVerifiedPaymentEvent,
  attachProviderPaymentId,
  createPendingPayment,
} from '@bahith/db';

import { getDatabase } from './db';

/**
 * Payment layer. No provider is active until the owner configures one AND authorizes
 * real transactions (CLAUDE.md / execution order). Until then every checkout and every
 * webhook fails with PAYMENTS_DISABLED and nothing is charged or simulated.
 *
 * A provider adapter implements two things: creating a hosted checkout for a pending
 * payment, and turning a webhook request into a VerifiedPaymentEvent ONLY after checking
 * its signature over the raw body. Activation happens solely from verified webhooks
 * (packages/db `applyVerifiedPaymentEvent`), never from the browser's return URL.
 */
export interface CheckoutRequest {
  workspaceId: string;
  planCode: string;
  userId: string;
}

export interface PaymentProvider {
  readonly id: string;
  createCheckout(payment: PendingPayment): Promise<{ url: string; providerPaymentId: string }>;
  /** Returns null when the signature or timestamp is not valid. */
  verifyWebhook(rawBody: string, headers: Headers): Promise<VerifiedPaymentEvent | null>;
}

export class PaymentsDisabledError extends Error {
  readonly code = 'PAYMENTS_DISABLED';
  constructor() {
    super('PAYMENTS_DISABLED');
    this.name = 'PaymentsDisabledError';
  }
}

/**
 * The configured provider. PAYMENTS_PROVIDER must name an implemented provider and
 * PAYMENTS_LIVE_AUTHORIZED must be "yes" (an explicit owner decision); there is no
 * implemented provider yet, so this always returns null.
 */
export function paymentProvider(): PaymentProvider | null {
  const provider = process.env.PAYMENTS_PROVIDER?.trim() ?? '';
  const authorized = process.env.PAYMENTS_LIVE_AUTHORIZED === 'yes';
  if (provider === '' || !authorized) return null;
  // No provider integration is shipped: adding one is a separate, authorized change.
  return null;
}

export async function startCheckout(request: CheckoutRequest): Promise<{ url: string }> {
  const provider = paymentProvider();
  if (provider === null) throw new PaymentsDisabledError();
  const payment = await createPendingPayment(getDatabase(), { ...request, provider: provider.id });
  const checkout = await provider.createCheckout(payment);
  await attachProviderPaymentId(
    getDatabase(),
    payment.workspaceId,
    payment.id,
    checkout.providerPaymentId,
  );
  return { url: checkout.url };
}

export type WebhookOutcome = 'disabled' | 'invalid_signature' | 'processed';

export async function handlePaymentWebhook(
  rawBody: string,
  headers: Headers,
): Promise<WebhookOutcome> {
  const provider = paymentProvider();
  if (provider === null) return 'disabled';
  const event = await provider.verifyWebhook(rawBody, headers);
  if (event === null || event.provider !== provider.id) return 'invalid_signature';
  await applyVerifiedPaymentEvent(getDatabase(), event);
  return 'processed';
}

/**
 * Shared building block for adapters: HMAC-SHA256 over `${timestamp}.${rawBody}`,
 * compared in constant time, with a freshness window against replays (duplicates within
 * the window are also stopped by the stored event id).
 */
export function verifyHmacSha256Signature(input: {
  secret: string;
  rawBody: string;
  timestamp: string;
  signatureHex: string;
  toleranceSeconds?: number;
  now?: Date;
}): boolean {
  const { secret, rawBody, timestamp, signatureHex } = input;
  if (
    secret === '' ||
    !/^[0-9]{1,12}$/u.test(timestamp) ||
    !/^[0-9a-f]{64}$/iu.test(signatureHex)
  ) {
    return false;
  }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > (input.toleranceSeconds ?? 300)) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(signatureHex, 'hex'));
}
