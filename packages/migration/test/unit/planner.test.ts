import { describe, expect, it } from 'vitest';

import type { Plan } from '../../src/index';
import {
  buildReport,
  dryRun,
  formatMinor,
  JsonDumpSource,
  planRecords,
  reportToMarkdown,
} from '../../src/index';
import { assumedMapping, GENERATED_AT, legacyDump } from '../fixtures';

async function plan(): Promise<Plan> {
  return dryRun(new JsonDumpSource(legacyDump, assumedMapping), assumedMapping);
}

function outcome(p: Plan, entity: string, id: string) {
  return p.outcomes.find((o) => o.entity === entity && o.legacyId === id);
}

describe('validation and deduplication', () => {
  it('rejects invalid rows with field-level reasons only', async () => {
    const p = await plan();
    expect(outcome(p, 'users', '7')).toMatchObject({
      status: 'rejected',
      reasons: ['missing_email'],
    });
    expect(outcome(p, 'users', '8')).toMatchObject({
      status: 'rejected',
      reasons: ['invalid:email'],
    });
    expect(outcome(p, 'subscriptions', '7')?.reasons).toEqual(['period_end_before_start']);
    expect(outcome(p, 'payments', '6')?.reasons).toEqual(['invalid:amountMinor']);
    expect(outcome(p, 'payments', '11')?.reasons).toEqual(['paid_without_paid_at']);
    expect(outcome(p, 'projects', '4')?.reasons).toEqual(['invalid:title']);
    expect(outcome(p, 'files', '3')?.reasons).toEqual(['file_without_location']);
    // Reasons never contain the offending values.
    expect(JSON.stringify(p.outcomes)).not.toContain('not-an-email');
  });

  it('merges case-insensitive e-mail duplicates into the earliest user and remaps children', async () => {
    const p = await plan();
    expect(outcome(p, 'users', '2')).toMatchObject({
      status: 'rejected',
      reasons: ['duplicate_email'],
      details: { duplicateOf: '1' },
    });
    expect(p.accepted.users.map((u) => u.legacyId)).toEqual(['1', '9', '10']);
    expect(p.accepted.users[0]?.email).toBe('amal@example.test');
    expect(p.accepted.users[0]?.phone).toBe('+966501234567');
    expect(p.accepted.projects.find((r) => r.legacyId === '2')?.userLegacyId).toBe('1');
    expect(p.accepted.subscriptions.find((s) => s.legacyId === '2')?.userLegacyId).toBe('1');
  });

  it('flags same e-mail with different phones and same phone with different e-mails', async () => {
    const p = await plan();
    for (const id of ['3', '4']) {
      expect(outcome(p, 'users', id)).toMatchObject({
        status: 'conflict',
        reasons: ['same_email_different_phone'],
        details: { email: 'b***@e***.org', group: '3,4' },
      });
    }
    for (const id of ['5', '6']) {
      expect(outcome(p, 'users', id)).toMatchObject({
        status: 'conflict',
        reasons: ['same_phone_different_email'],
      });
    }
    // Children of a conflicting user are held back, not dropped.
    expect(outcome(p, 'projects', '3')).toMatchObject({
      status: 'conflict',
      reasons: ['user_in_conflict'],
    });
    expect(outcome(p, 'telegramLinks', '444')?.status).toBe('conflict');
    expect(outcome(p, 'telegramLinks', '333')).toMatchObject({
      status: 'rejected',
      reasons: ['user_rejected'],
    });
  });

  it('deduplicates payments by provider reference and keeps a reference clash as conflict', async () => {
    const p = await plan();
    expect(outcome(p, 'payments', '3')).toMatchObject({
      status: 'rejected',
      reasons: ['duplicate_provider_reference'],
      details: { duplicateOf: '2' },
    });
    const clash = planRecords(
      {
        users: [{ legacyId: 'u', email: 'x@example.test', createdAt: '2024-01-01' }],
        payments: [
          {
            legacyId: 'p1',
            userLegacyId: 'u',
            amount: '10',
            currency: 'SAR',
            provider: 'gw',
            providerReference: 'R',
            status: 'paid',
            paidAt: '2024-01-02',
          },
          {
            legacyId: 'p2',
            userLegacyId: 'u',
            amount: '11',
            currency: 'SAR',
            provider: 'gw',
            providerReference: 'R',
            status: 'paid',
            paidAt: '2024-01-02',
          },
        ],
      },
      {
        ...assumedMapping,
        entities: {
          users: identity(['legacyId', 'email', 'createdAt']),
          payments: identity([
            'legacyId',
            'userLegacyId',
            'amount',
            'currency',
            'provider',
            'providerReference',
            'status',
            'paidAt',
          ]),
        },
      },
    );
    expect(clash.outcomes.filter((o) => o.entity === 'payments').map((o) => o.reasons)).toEqual([
      ['provider_reference_conflict'],
      ['provider_reference_conflict'],
    ]);
  });
});

/** An identity mapping for hand-written canonical-shaped rows. */
function identity(fields: string[]) {
  return {
    table: 't',
    key: 'legacyId',
    fields: Object.fromEntries(fields.map((f) => [f, f])),
    constants: {},
    values: {},
    amountUnit: 'major' as const,
  };
}

describe('conflict detection', () => {
  it('detects payments without user, overlapping periods, unpaid subscriptions and outliers', async () => {
    const p = await plan();
    expect(outcome(p, 'payments', '5')).toMatchObject({
      status: 'conflict',
      reasons: ['payment_without_user'],
    });
    expect(outcome(p, 'subscriptions', '3')).toMatchObject({
      status: 'conflict',
      reasons: ['overlapping_period'],
    });
    expect(outcome(p, 'subscriptions', '4')?.reasons).toEqual([
      'overlapping_period',
      'subscription_without_payment',
    ]);
    expect(outcome(p, 'subscriptions', '5')?.status).toBe('accepted'); // free plan
    expect(outcome(p, 'subscriptions', '6')?.reasons).toEqual(['orphan_user']);
    expect(outcome(p, 'payments', '7')).toMatchObject({
      status: 'conflict',
      reasons: ['amount_outlier'],
      details: { currencyMedianMinor: '4900' },
    });
  });

  it('flags non-positive paid amounts', () => {
    const p = planRecords(
      {
        users: [{ legacyId: 'u', email: 'x@example.test', createdAt: '2024-01-01' }],
        payments: [
          {
            legacyId: 'p',
            userLegacyId: 'u',
            amount: '0',
            currency: 'SAR',
            provider: 'gw',
            status: 'paid',
            paidAt: '2024-01-02',
          },
        ],
      },
      {
        ...assumedMapping,
        entities: {
          users: identity(['legacyId', 'email', 'createdAt']),
          payments: identity([
            'legacyId',
            'userLegacyId',
            'amount',
            'currency',
            'provider',
            'status',
            'paidAt',
          ]),
        },
      },
    );
    expect(p.outcomes.find((o) => o.entity === 'payments')?.reasons).toEqual([
      'amount_non_positive',
    ]);
  });
});

describe('financial reconciliation', () => {
  it('sums paid payments per currency and month against covered subscriptions', async () => {
    const p = await plan();
    expect(p.reconciliation.rows).toEqual([
      // Mar: REF-8 matched to subscription 1 by period (31 days)
      {
        currency: 'KWD',
        month: '2024-03',
        paidCount: 1,
        paidTotalMinor: 9000,
        matchedTotalMinor: 9000,
        unmatchedTotalMinor: 0,
        refundedCount: 0,
        refundedTotalMinor: 0,
        coveredSubscriptionDays: 31,
      },
      // Mar: REF-1 (sub 1, 31 d), REF-4 (sub 3, 92 d), REF-5 unmatched
      {
        currency: 'SAR',
        month: '2024-03',
        paidCount: 3,
        paidTotalMinor: 14700,
        matchedTotalMinor: 9800,
        unmatchedTotalMinor: 4900,
        refundedCount: 0,
        refundedTotalMinor: 0,
        coveredSubscriptionDays: 123,
      },
      // Apr: REF-2 (sub 2, 30 d); REF-9 refunded
      {
        currency: 'SAR',
        month: '2024-04',
        paidCount: 1,
        paidTotalMinor: 4900,
        matchedTotalMinor: 4900,
        unmatchedTotalMinor: 0,
        refundedCount: 1,
        refundedTotalMinor: 4900,
        coveredSubscriptionDays: 30,
      },
      // May: REF-7 outlier, unmatched
      {
        currency: 'SAR',
        month: '2024-05',
        paidCount: 1,
        paidTotalMinor: 490000,
        matchedTotalMinor: 0,
        unmatchedTotalMinor: 490000,
        refundedCount: 0,
        refundedTotalMinor: 0,
        coveredSubscriptionDays: 0,
      },
    ]);
    expect(p.reconciliation.totalsByCurrency).toEqual([
      { currency: 'KWD', paidTotalMinor: 9000, unmatchedTotalMinor: 0 },
      { currency: 'SAR', paidTotalMinor: 509600, unmatchedTotalMinor: 494900 },
    ]);
    expect(p.reconciliation.unmatchedPayments).toEqual(['5', '7']);
    expect(p.reconciliation.paymentIdempotencyKeys.map((k) => k.key)).toContain('payment:gw:REF-1');
    // Rejected duplicates never get a key of their own.
    expect(p.reconciliation.paymentIdempotencyKeys.map((k) => k.legacyId)).not.toContain('3');
  });

  it('formats minor units with the currency exponent', () => {
    expect(formatMinor(4900, 'SAR')).toBe('49.00 SAR');
    expect(formatMinor(9000, 'KWD')).toBe('9.000 KWD');
    expect(formatMinor(5, 'SAR')).toBe('0.05 SAR');
    expect(formatMinor(-120, 'JPY')).toBe('-120 JPY');
  });
});

describe('report', () => {
  it('is deterministic, contains no personal data, and matches the snapshot', async () => {
    const meta = { generatedAt: GENERATED_AT, sourceKind: 'json', mode: 'dry-run' as const };
    const a = buildReport(await plan(), meta);
    // Same input in a different row order → identical report.
    const shuffled = Object.fromEntries(
      Object.entries(legacyDump).map(([table, rows]) => [table, [...rows].reverse()]),
    );
    const b = buildReport(
      await dryRun(new JsonDumpSource(shuffled, assumedMapping), assumedMapping),
      meta,
    );
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const markdown = reportToMarkdown(a);
    const text = JSON.stringify(a) + markdown;
    for (const member of legacyDump.members) {
      if (member.email !== null) expect(text).not.toContain(member.email);
      if (member.full_name !== '') expect(text).not.toContain(member.full_name);
      if (member.mobile !== null && member.mobile.length > 4)
        expect(text).not.toContain(member.mobile);
    }
    expect(text).not.toContain('Research one');
    expect(text).not.toContain('legacy/u1.pdf');
    expect(a.counts.users).toEqual({ read: 10, accepted: 3, rejected: 3, conflict: 4 });
    expect(markdown).toMatchSnapshot();
  });
});
