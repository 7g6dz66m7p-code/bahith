import { describe, expect, it } from 'vitest';

import { createSmsSender, isE164 } from '../../src/sms';

describe('SMS sender selection', () => {
  it('has no sender unless configured, and capture works on localhost only', () => {
    expect(createSmsSender({}, 'http://localhost:3100')).toBeNull();
    expect(
      createSmsSender(
        { SMS_PROVIDER: 'capture', SMS_CAPTURE_DIR: '/tmp' },
        'https://al-bahith.com',
      ),
    ).toBeNull();
    expect(createSmsSender({ SMS_PROVIDER: 'capture' }, 'http://localhost:3100')).toBeNull();
    expect(
      createSmsSender({ SMS_PROVIDER: 'capture', SMS_CAPTURE_DIR: '/tmp' }, 'http://localhost:3100')
        ?.id,
    ).toBe('capture');
    expect(createSmsSender({ SMS_PROVIDER: 'some-vendor' }, 'https://al-bahith.com')).toBeNull();
  });

  it('accepts E.164 numbers only', () => {
    expect(isE164('+9647701234567')).toBe(true);
    expect(isE164('+966501234567')).toBe(true);
    expect(isE164('07701234567')).toBe(false);
    expect(isE164('+0123456789')).toBe(false);
  });
});
