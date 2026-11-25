import { z } from 'zod';

/**
 * Canonical intermediate records. Every legacy row is mapped into one of these shapes
 * and validated before the planner looks at it; nothing reaches the new platform
 * without passing through here.
 */

export const ENTITIES = [
  'users',
  'subscriptions',
  'payments',
  'projects',
  'files',
  'telegramLinks',
] as const;
export type Entity = (typeof ENTITIES)[number];

const legacyId = z.string().trim().min(1).max(200);
const isoDate = z.date();

/** ISO 4217 minor-unit exponents for currencies that do not use 2 decimals. */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  JPY: 0,
  KRW: 0,
};

export function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENTS[currency] ?? 2;
}

export const E164 = /^\+[1-9]\d{7,14}$/;

export const userSchema = z.strictObject({
  legacyId,
  email: z.string().trim().toLowerCase().pipe(z.email()).nullable(),
  phone: z.string().regex(E164).nullable(),
  name: z.string().trim().max(200),
  createdAt: isoDate,
  updatedAt: isoDate.nullable(),
});
export type CanonicalUser = z.infer<typeof userSchema>;

export const subscriptionStatus = z.enum(['active', 'trialing', 'past_due', 'canceled', 'expired']);
export const subscriptionSchema = z
  .strictObject({
    legacyId,
    userLegacyId: legacyId,
    planCode: z.string().trim().min(1).max(64),
    status: subscriptionStatus,
    periodStart: isoDate,
    periodEnd: isoDate,
    paymentLegacyId: legacyId.nullable(),
    updatedAt: isoDate.nullable(),
  })
  .refine((s) => s.periodEnd.getTime() > s.periodStart.getTime(), {
    message: 'period_end_before_start',
    path: ['periodEnd'],
  });
export type CanonicalSubscription = z.infer<typeof subscriptionSchema>;

export const paymentStatus = z.enum(['paid', 'pending', 'failed', 'refunded']);
export const paymentSchema = z
  .strictObject({
    legacyId,
    userLegacyId: legacyId.nullable(),
    subscriptionLegacyId: legacyId.nullable(),
    amountMinor: z.number().int(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    provider: z.string().trim().min(1).max(64),
    providerReference: z.string().trim().min(1).max(200).nullable(),
    status: paymentStatus,
    paidAt: isoDate.nullable(),
    updatedAt: isoDate.nullable(),
  })
  .refine((p) => p.status !== 'paid' || p.paidAt !== null, {
    message: 'paid_without_paid_at',
    path: ['paidAt'],
  });
export type CanonicalPayment = z.infer<typeof paymentSchema>;

export const projectSchema = z.strictObject({
  legacyId,
  userLegacyId: legacyId,
  title: z.string().trim().min(1).max(200),
  researchQuestion: z.string().trim().max(5000),
  language: z.enum(['ar', 'en']),
  createdAt: isoDate,
  updatedAt: isoDate.nullable(),
});
export type CanonicalProject = z.infer<typeof projectSchema>;

export const fileSchema = z
  .strictObject({
    legacyId,
    userLegacyId: legacyId,
    projectLegacyId: legacyId.nullable(),
    storagePath: z.string().trim().min(1).max(2000).nullable(),
    url: z.url().nullable(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    mimeType: z.string().max(200).nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    updatedAt: isoDate.nullable(),
  })
  .refine((f) => f.storagePath !== null || f.url !== null, {
    message: 'file_without_location',
    path: ['storagePath'],
  });
export type CanonicalFile = z.infer<typeof fileSchema>;

export const telegramLinkSchema = z.strictObject({
  legacyId,
  telegramUserId: z.string().regex(/^[1-9]\d{0,19}$/),
  userLegacyId: legacyId,
  updatedAt: isoDate.nullable(),
});
export type CanonicalTelegramLink = z.infer<typeof telegramLinkSchema>;

export interface CanonicalByEntity {
  users: CanonicalUser;
  subscriptions: CanonicalSubscription;
  payments: CanonicalPayment;
  projects: CanonicalProject;
  files: CanonicalFile;
  telegramLinks: CanonicalTelegramLink;
}

export const canonicalSchemas = {
  users: userSchema,
  subscriptions: subscriptionSchema,
  payments: paymentSchema,
  projects: projectSchema,
  files: fileSchema,
  telegramLinks: telegramLinkSchema,
} as const;
