import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  handlePaymentWebhook,
  paymentProvider,
  PaymentsDisabledError,
  startCheckout,
  verifyHmacSha256Signature,
} from '@/server/billing';

const secret = 'unit-test-webhook-secret';
const now = new Date('2026-11-24T12:00:00Z');
const timestamp = String(Math.floor(now.getTime() / 1000));
const rawBody = '{"id":"evt_1"}';
const sign = (body: string, ts = timestamp) =>
  createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

describe('payments stay disabled until a provider is integrated and authorized', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('no provider is returned, even when one is named and authorized', () => {
    expect(paymentProvider()).toBeNull();
    vi.stubEnv('PAYMENTS_PROVIDER', 'anything');
    vi.stubEnv('PAYMENTS_LIVE_AUTHORIZED', 'yes');
    expect(paymentProvider()).toBeNull();
  });

  it('checkout and webhooks refuse without touching the database', async () => {
    await expect(
      startCheckout({
        workspaceId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        planCode: 'pro',
      }),
    ).rejects.toBeInstanceOf(PaymentsDisabledError);
    expect(await handlePaymentWebhook(rawBody, new Headers())).toBe('disabled');
  });
});

describe('verifyHmacSha256Signature', () => {
  const base = { secret, rawBody, timestamp, now };

  it('accepts the exact signed body within the window', () => {
    expect(verifyHmacSha256Signature({ ...base, signatureHex: sign(rawBody) })).toBe(true);
  });

  it('rejects a changed body, a wrong secret, a malformed or stale signature', () => {
    expect(verifyHmacSha256Signature({ ...base, signatureHex: sign('{"id":"evt_2"}') })).toBe(
      false,
    );
    expect(
      verifyHmacSha256Signature({ ...base, secret: 'other', signatureHex: sign(rawBody) }),
    ).toBe(false);
    expect(verifyHmacSha256Signature({ ...base, signatureHex: 'abc' })).toBe(false);
    expect(verifyHmacSha256Signature({ ...base, secret: '', signatureHex: sign(rawBody) })).toBe(
      false,
    );
    const old = String(Number(timestamp) - 301);
    expect(
      verifyHmacSha256Signature({ ...base, timestamp: old, signatureHex: sign(rawBody, old) }),
    ).toBe(false);
  });
});
