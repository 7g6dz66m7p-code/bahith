import { appendFile } from 'node:fs/promises';
import path from 'node:path';

/** Delivers a one-time code by SMS. Implementations never log the code or the number. */
export interface SmsSender {
  readonly id: string;
  sendOtp(phoneNumber: string, code: string): Promise<void>;
}

export class SmsUnavailableError extends Error {
  readonly code = 'SMS_NOT_CONFIGURED';
  constructor() {
    super('SMS_NOT_CONFIGURED');
    this.name = 'SmsUnavailableError';
  }
}

/**
 * The configured sender. No real SMS provider is integrated until the owner chooses one
 * (its keys then go into the environment's secrets). `capture` writes codes to a local
 * file for automated tests and is refused unless the platform runs on localhost.
 */
export function createSmsSender(
  env: Record<string, string | undefined>,
  baseUrl: string,
): SmsSender | null {
  const provider = env.SMS_PROVIDER?.trim() ?? '';
  if (provider === 'capture') {
    const host = new URL(baseUrl).hostname;
    const dir = env.SMS_CAPTURE_DIR?.trim() ?? '';
    if (!['localhost', '127.0.0.1'].includes(host) || dir === '') return null;
    return {
      id: 'capture',
      async sendOtp(phoneNumber, code) {
        await appendFile(
          path.join(dir, 'sms.jsonl'),
          `${JSON.stringify({ phoneNumber, code })}\n`,
          {
            mode: 0o600,
          },
        );
      },
    };
  }
  return null;
}

/** E.164: + then 7–15 digits, no leading zero in the country code. */
export function isE164(phoneNumber: string): boolean {
  return /^\+[1-9][0-9]{6,14}$/u.test(phoneNumber);
}
