import { describe, expect, it } from 'vitest';

import {
  buildSelect,
  maskEmail,
  maskPhone,
  normalize,
  parseMapping,
  projectRow,
  toDate,
  toE164,
  toMinorUnits,
} from '../../src/index';
import { assumedMapping } from '../fixtures';

describe('mapping file', () => {
  it('parses the assumed mapping', () => {
    expect(assumedMapping.entities.users?.table).toBe('legacy.members');
    expect(assumedMapping.defaults.language).toBe('ar');
  });

  it('rejects unsafe identifiers, unknown fields and a missing legacyId', () => {
    const base = {
      version: 1,
      entities: { users: { table: 'members', key: 'id', fields: { legacyId: 'id' } } },
    };
    expect(() => parseMapping(base)).not.toThrow();
    expect(() =>
      parseMapping({
        ...base,
        entities: {
          users: { table: 'members; drop table x', key: 'id', fields: { legacyId: 'id' } },
        },
      }),
    ).toThrow();
    expect(() =>
      parseMapping({
        ...base,
        entities: { users: { table: 'members', key: 'id', fields: { legacyId: 'id"--' } } },
      }),
    ).toThrow();
    expect(() =>
      parseMapping({
        ...base,
        entities: {
          users: { table: 'members', key: 'id', fields: { legacyId: 'id', password: 'pw' } },
        },
      }),
    ).toThrow(/unknown_field:password/);
    expect(() =>
      parseMapping({
        ...base,
        entities: { users: { table: 'members', key: 'id', fields: { email: 'email' } } },
      }),
    ).toThrow(/legacyId_required/);
    expect(() => parseMapping({ version: 1, entities: {} })).toThrow(/users_mapping_required/);
  });

  it('projects legacy columns onto canonical fields, with constants', () => {
    const m = {
      table: 't',
      key: 'id',
      fields: { legacyId: 'id', email: 'mail' },
      constants: { name: 'x' },
      values: {},
      amountUnit: 'major' as const,
    };
    expect(projectRow(m, { id: 5, mail: 'a@b.test', secret: 'never' })).toEqual({
      name: 'x',
      legacyId: 5,
      email: 'a@b.test',
    });
  });

  it('builds a parameterised keyset SELECT with quoted identifiers', () => {
    const m = assumedMapping.entities.users;
    if (m === undefined) throw new Error('mapping');
    expect(buildSelect(m, { afterKey: false, since: false })).toBe(
      'SELECT "id", "email", "mobile", "full_name", "created_on", "updated_on" FROM "legacy"."members" ORDER BY "id" LIMIT $1',
    );
    expect(buildSelect(m, { afterKey: true, since: true })).toBe(
      'SELECT "id", "email", "mobile", "full_name", "created_on", "updated_on" FROM "legacy"."members" WHERE "id" > $1 AND "updated_on" >= $2 ORDER BY "id" LIMIT $3',
    );
  });
});

describe('value normalisation', () => {
  it('normalises phones to E.164', () => {
    expect(toE164('050 123 4567', '966')).toBe('+966501234567');
    expect(toE164('00966501234567')).toBe('+966501234567');
    expect(toE164('+966 (50) 123-4567')).toBe('+966501234567');
    expect(toE164('966501234567', '966')).toBe('+966501234567');
    expect(toE164('0501234567')).toBeNull(); // no default country code
    expect(toE164('12', '966')).toBeNull();
    expect(toE164(null)).toBeNull();
  });

  it('converts amounts to minor units without floating point', () => {
    expect(toMinorUnits('49.00', 'SAR', 'major')).toBe(4900);
    expect(toMinorUnits('49.9', 'SAR', 'major')).toBe(4990);
    expect(toMinorUnits('0.30', 'SAR', 'major')).toBe(30);
    expect(toMinorUnits('9.125', 'KWD', 'major')).toBe(9125);
    expect(toMinorUnits('1000', 'JPY', 'major')).toBe(1000);
    expect(toMinorUnits('49.999', 'SAR', 'major')).toBeNull();
    expect(toMinorUnits('4900', 'SAR', 'minor')).toBe(4900);
    expect(toMinorUnits('49.5', 'SAR', 'minor')).toBeNull();
    expect(toMinorUnits('-5.00', 'SAR', 'major')).toBe(-500);
    expect(toMinorUnits('1e3', 'SAR', 'major')).toBeNull();
    expect(toMinorUnits(49, 'SAR', 'major')).toBe(4900);
  });

  it('parses dates deterministically as UTC', () => {
    expect(toDate('2024-03-01')?.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(toDate('2024-03-01 10:20:30')?.toISOString()).toBe('2024-03-01T10:20:30.000Z');
    expect(toDate(1709287200)?.toISOString()).toBe('2024-03-01T10:00:00.000Z');
    expect(toDate('1709287200000')?.toISOString()).toBe('2024-03-01T10:00:00.000Z');
    expect(toDate('garbage')).toBeNull();
  });

  it('maps legacy status codes and lower-cases e-mails', () => {
    const sub = normalize(
      'subscriptions',
      {
        legacyId: 1,
        userLegacyId: 2,
        planCode: 'premium',
        status: '0',
        periodStart: '2024-01-01',
        periodEnd: '2024-02-01',
      },
      assumedMapping,
    );
    expect(sub.ok && sub.record).toMatchObject({
      planCode: 'pro',
      status: 'expired',
      legacyId: '1',
      userLegacyId: '2',
    });
    const user = normalize(
      'users',
      { legacyId: 1, email: ' A@Example.TEST ', createdAt: '2024-01-01' },
      assumedMapping,
    );
    expect(user.ok && user.record.email).toBe('a@example.test');
  });
});

describe('masking', () => {
  it('masks e-mails and phones', () => {
    expect(maskEmail('ahmed@domain.com')).toBe('a***@d***.com');
    expect(maskEmail('x@localhost')).toBe('x***@l***');
    expect(maskEmail('broken')).toBe('***');
    expect(maskEmail(null)).toBe('***');
    expect(maskPhone('+966501234567')).toBe('+966***67');
    expect(maskPhone('12')).toBe('***');
  });
});
