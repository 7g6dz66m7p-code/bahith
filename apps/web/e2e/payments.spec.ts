import { expect, test } from '@playwright/test';

test('payment webhooks are refused while payments are disabled', async ({ request }) => {
  const response = await request.post('/api/payments/webhook', {
    headers: { 'content-type': 'application/json' },
    data: { id: 'evt_forged', type: 'payment.succeeded' },
  });
  expect(response.status()).toBe(503);
  expect(await response.json()).toEqual({ code: 'PAYMENTS_DISABLED' });
  const tooLarge = await request.post('/api/payments/webhook', { data: 'x'.repeat(70 * 1024) });
  expect(tooLarge.status()).toBe(413);
});
