import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Where the localhost-only `capture` SMS sender writes codes during e2e runs. */
export const SMS_CAPTURE_DIR = path.join(os.tmpdir(), 'bahith-e2e-sms');

/** Latest one-time code captured for `phoneNumber`. */
export async function readCapturedCode(phoneNumber: string): Promise<string> {
  const lines = (await readFile(path.join(SMS_CAPTURE_DIR, 'sms.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { phoneNumber: string; code: string })
    .filter((entry) => entry.phoneNumber === phoneNumber);
  const last = lines.at(-1);
  if (last === undefined) throw new Error('No SMS captured for this number');
  return last.code;
}

/**
 * Test-only Telegram bot token, generated per e2e run by the server harness (never a real
 * bot). The spec signs Login Widget data with it exactly as Telegram would.
 */
export const TELEGRAM_TEST_TOKEN_FILE = path.join(SMS_CAPTURE_DIR, 'telegram-test-token');
