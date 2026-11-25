import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { CanonicalByEntity, Entity } from './canonical';
import { canonicalSchemas, currencyExponent, E164, ENTITIES } from './canonical';

/**
 * Declarative mapping from the (unknown until the owner provides it) legacy schema to
 * the canonical records. The same file drives the Postgres reader and the JSON dump
 * reader, so the real schema is plugged in by editing JSON, never code.
 */

/** A SQL identifier we are willing to quote: letters, digits, underscore. */
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'invalid_identifier');
const qualifiedTable = z
  .string()
  .regex(/^([A-Za-z_][A-Za-z0-9_]{0,62}\.)?[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'invalid_table');

const CANONICAL_FIELDS = {
  users: ['legacyId', 'email', 'phone', 'name', 'createdAt', 'updatedAt'],
  subscriptions: [
    'legacyId',
    'userLegacyId',
    'planCode',
    'status',
    'periodStart',
    'periodEnd',
    'paymentLegacyId',
    'updatedAt',
  ],
  payments: [
    'legacyId',
    'userLegacyId',
    'subscriptionLegacyId',
    'amount',
    'currency',
    'provider',
    'providerReference',
    'status',
    'paidAt',
    'updatedAt',
  ],
  projects: [
    'legacyId',
    'userLegacyId',
    'title',
    'researchQuestion',
    'language',
    'createdAt',
    'updatedAt',
  ],
  files: [
    'legacyId',
    'userLegacyId',
    'projectLegacyId',
    'storagePath',
    'url',
    'sha256',
    'mimeType',
    'sizeBytes',
    'updatedAt',
  ],
  telegramLinks: ['legacyId', 'telegramUserId', 'userLegacyId', 'updatedAt'],
} as const satisfies Record<Entity, readonly string[]>;

const entityMappingSchema = z.strictObject({
  table: qualifiedTable,
  /** Legacy column used for stable keyset ordering (normally the primary key). */
  key: identifier,
  /** canonical field → legacy column. `legacyId` is required. */
  fields: z.record(z.string(), identifier),
  /** Constant values for canonical fields the legacy table does not carry. */
  constants: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
  /** canonical field → { legacy value → canonical value } (e.g. status codes). */
  values: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /** payments only: whether `amount` is stored in major units (12.50) or minor (1250). */
  amountUnit: z.enum(['major', 'minor']).default('major'),
});
export type EntityMapping = z.infer<typeof entityMappingSchema>;

export const mappingSchema = z
  .strictObject({
    version: z.literal(1),
    description: z.string().optional(),
    defaults: z
      .strictObject({
        /** Country calling code for local numbers that start with 0 (e.g. "966"). */
        phoneCountryCode: z
          .string()
          .regex(/^[1-9]\d{0,3}$/)
          .optional(),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional(),
        language: z.enum(['ar', 'en']).default('ar'),
        provider: z.string().min(1).optional(),
      })
      .prefault({}),
    entities: z
      .strictObject({
        users: entityMappingSchema.optional(),
        subscriptions: entityMappingSchema.optional(),
        payments: entityMappingSchema.optional(),
        projects: entityMappingSchema.optional(),
        files: entityMappingSchema.optional(),
        telegramLinks: entityMappingSchema.optional(),
      })
      .refine((e) => e.users !== undefined, { message: 'users_mapping_required' }),
  })
  .superRefine((mapping, ctx) => {
    for (const entity of ENTITIES) {
      const m = mapping.entities[entity];
      if (m === undefined) continue;
      const allowed: readonly string[] = CANONICAL_FIELDS[entity];
      if (m.fields['legacyId'] === undefined) {
        ctx.addIssue({ code: 'custom', message: 'legacyId_required', path: [entity, 'fields'] });
      }
      for (const field of [...Object.keys(m.fields), ...Object.keys(m.constants)]) {
        if (!allowed.includes(field)) {
          ctx.addIssue({ code: 'custom', message: `unknown_field:${field}`, path: [entity] });
        }
      }
    }
  });
export type Mapping = z.infer<typeof mappingSchema>;

export function parseMapping(input: unknown): Mapping {
  return mappingSchema.parse(input);
}

export async function loadMapping(path: string): Promise<Mapping> {
  return parseMapping(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

/** A legacy row already projected onto canonical field names (values still raw). */
export type RawRecord = Record<string, unknown>;

/** Projects one legacy row (legacy column names) onto canonical field names. */
export function projectRow(m: EntityMapping, row: Record<string, unknown>): RawRecord {
  const out: RawRecord = { ...m.constants };
  for (const [field, column] of Object.entries(m.fields)) out[field] = row[column];
  return out;
}

// ---------------------------------------------------------------------------
// Value normalisation
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return null;
}

export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const asNumber =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (Number.isFinite(asNumber)) {
    // Seconds until year 33658; milliseconds beyond that.
    const date = new Date(asNumber < 1e12 ? asNumber * 1000 : asNumber);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string') return null;
  // A bare date or a timestamp without zone is interpreted as UTC, deterministically.
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00Z`
    : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Normalises a phone number to E.164, or returns null if that is not possible. */
export function toE164(value: unknown, countryCode?: string): string | null {
  const raw = str(value);
  if (raw === null) return null;
  let digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (!digits.startsWith('+')) {
    if (countryCode !== undefined && /^0\d+$/.test(digits)) {
      digits = `+${countryCode}${digits.slice(1)}`;
    } else if (countryCode !== undefined && digits.startsWith(countryCode)) {
      digits = `+${digits}`;
    } else {
      return null;
    }
  }
  return E164.test(digits) ? digits : null;
}

/**
 * Converts an amount to integer minor units without floating-point arithmetic.
 * Returns null when the value has more precision than the currency allows.
 */
export function toMinorUnits(
  value: unknown,
  currency: string,
  unit: 'major' | 'minor',
): number | null {
  const raw = str(value);
  if (raw === null) return null;
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(raw);
  if (match === null) return null;
  const [, sign, whole = '', fraction = ''] = match;
  if (unit === 'minor') {
    if (fraction.replace(/0+$/, '') !== '') return null;
    const n = Number(whole);
    return Number.isSafeInteger(n) ? (sign === '-' ? -n : n) : null;
  }
  const exponent = currencyExponent(currency);
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length > exponent) return null;
  const n = Number(`${whole}${trimmed.padEnd(exponent, '0')}`);
  if (!Number.isSafeInteger(n)) return null;
  return sign === '-' ? -n : n;
}

function mapValue(m: EntityMapping, field: string, value: unknown): unknown {
  const table = m.values[field];
  const key = str(value);
  if (table === undefined || key === null) return value;
  return table[key] ?? table[key.toLowerCase()] ?? value;
}

export type NormalizeResult<E extends Entity> =
  | { ok: true; record: CanonicalByEntity[E]; warnings: string[] }
  | { ok: false; legacyId: string | null; reasons: string[] };

/**
 * Converts a projected raw record to a validated canonical record. Rejection reasons
 * name the field and the rule only, never the offending value (it may be personal data).
 */
export function normalize<E extends Entity>(
  entity: E,
  raw: RawRecord,
  mapping: Mapping,
): NormalizeResult<E> {
  const m = mapping.entities[entity];
  if (m === undefined) throw new Error(`no mapping for ${entity}`);
  const v = (field: string) => mapValue(m, field, raw[field]);
  const warnings: string[] = [];
  let candidate: Record<string, unknown>;

  switch (entity) {
    case 'users': {
      const phoneRaw = str(v('phone'));
      const phone = toE164(phoneRaw, mapping.defaults.phoneCountryCode);
      if (phoneRaw !== null && phone === null) warnings.push('phone_not_e164_dropped');
      candidate = {
        legacyId: str(v('legacyId')),
        email: str(v('email'))?.toLowerCase() ?? null,
        phone,
        name: str(v('name')) ?? '',
        createdAt: toDate(v('createdAt')),
        updatedAt: toDate(v('updatedAt')),
      };
      break;
    }
    case 'subscriptions':
      candidate = {
        legacyId: str(v('legacyId')),
        userLegacyId: str(v('userLegacyId')),
        planCode: str(v('planCode')),
        status: str(v('status'))?.toLowerCase(),
        periodStart: toDate(v('periodStart')),
        periodEnd: toDate(v('periodEnd')),
        paymentLegacyId: str(v('paymentLegacyId')),
        updatedAt: toDate(v('updatedAt')),
      };
      break;
    case 'payments': {
      const currency = (str(v('currency')) ?? mapping.defaults.currency ?? '').toUpperCase();
      const amountMinor = toMinorUnits(v('amount'), currency, m.amountUnit);
      candidate = {
        legacyId: str(v('legacyId')),
        userLegacyId: str(v('userLegacyId')),
        subscriptionLegacyId: str(v('subscriptionLegacyId')),
        amountMinor,
        currency,
        provider: str(v('provider')) ?? mapping.defaults.provider ?? null,
        providerReference: str(v('providerReference')),
        status: str(v('status'))?.toLowerCase(),
        paidAt: toDate(v('paidAt')),
        updatedAt: toDate(v('updatedAt')),
      };
      break;
    }
    case 'projects':
      candidate = {
        legacyId: str(v('legacyId')),
        userLegacyId: str(v('userLegacyId')),
        title: str(v('title')),
        researchQuestion: str(v('researchQuestion')) ?? '',
        language: str(v('language'))?.toLowerCase() ?? mapping.defaults.language,
        createdAt: toDate(v('createdAt')),
        updatedAt: toDate(v('updatedAt')),
      };
      break;
    case 'files': {
      const size = str(v('sizeBytes'));
      candidate = {
        legacyId: str(v('legacyId')),
        userLegacyId: str(v('userLegacyId')),
        projectLegacyId: str(v('projectLegacyId')),
        storagePath: str(v('storagePath')),
        url: str(v('url')),
        sha256: str(v('sha256'))?.toLowerCase() ?? null,
        mimeType: str(v('mimeType')),
        sizeBytes: size === null ? null : /^\d+$/.test(size) ? Number(size) : -1,
        updatedAt: toDate(v('updatedAt')),
      };
      break;
    }
    case 'telegramLinks':
      candidate = {
        legacyId: str(v('legacyId')) ?? str(v('telegramUserId')),
        telegramUserId: str(v('telegramUserId')),
        userLegacyId: str(v('userLegacyId')),
        updatedAt: toDate(v('updatedAt')),
      };
      break;
  }

  const parsed = canonicalSchemas[entity].safeParse(candidate);
  if (parsed.success) {
    return { ok: true, record: parsed.data as CanonicalByEntity[E], warnings };
  }
  const reasons = [
    ...new Set(
      parsed.error.issues.map((issue) => {
        const path = issue.path.join('.');
        return issue.code === 'custom' ? issue.message : `invalid:${path}`;
      }),
    ),
  ].sort();
  return { ok: false, legacyId: str(candidate['legacyId']), reasons };
}
