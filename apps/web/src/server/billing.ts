/**
 * Payment layer. No provider is active until the owner configures one AND authorizes
 * real transactions (CLAUDE.md / execution order). Until then every checkout fails with
 * PAYMENTS_DISABLED and nothing is charged or simulated.
 */
export interface CheckoutRequest {
  workspaceId: string;
  planCode: string;
  userId: string;
}

export interface PaymentProvider {
  readonly id: string;
  createCheckout(request: CheckoutRequest): Promise<{ url: string }>;
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
  return provider.createCheckout(request);
}
