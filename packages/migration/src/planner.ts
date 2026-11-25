import type {
  CanonicalByEntity,
  CanonicalFile,
  CanonicalPayment,
  CanonicalProject,
  CanonicalSubscription,
  CanonicalTelegramLink,
  CanonicalUser,
  Entity,
} from './canonical';
import { ENTITIES } from './canonical';
import type { Mapping, RawRecord } from './mapping';
import { normalize } from './mapping';
import { maskEmail } from './mask';
import type { LegacySource, ReadOptions } from './source';

export type RowStatus = 'accepted' | 'rejected' | 'conflict';

export interface RowOutcome {
  entity: Entity;
  /** Legacy id, or `#<row index>` when the row has no usable id. */
  legacyId: string;
  status: RowStatus;
  reasons: string[];
  /** Non-personal context only: other legacy ids, masked e-mails. */
  details?: Record<string, string>;
}

export interface PlanWarning {
  entity: Entity;
  legacyId: string;
  warning: string;
}

export interface ReconciliationRow {
  currency: string;
  /** UTC month of `paid_at`, `YYYY-MM`. */
  month: string;
  paidCount: number;
  paidTotalMinor: number;
  matchedTotalMinor: number;
  unmatchedTotalMinor: number;
  refundedCount: number;
  refundedTotalMinor: number;
  /** Distinct subscription days covered by the matched payments of this bucket. */
  coveredSubscriptionDays: number;
}

export interface Reconciliation {
  rows: ReconciliationRow[];
  totalsByCurrency: { currency: string; paidTotalMinor: number; unmatchedTotalMinor: number }[];
  unmatchedPayments: string[];
  /** payment legacy id → idempotency key used by apply mode and the gateway check. */
  paymentIdempotencyKeys: { legacyId: string; key: string }[];
}

/** Accepted, normalised records ready for apply mode (user ids resolved to keepers). */
export interface AcceptedRecords {
  users: CanonicalUser[];
  subscriptions: CanonicalSubscription[];
  payments: CanonicalPayment[];
  projects: CanonicalProject[];
  files: CanonicalFile[];
  telegramLinks: CanonicalTelegramLink[];
}

export interface Plan {
  outcomes: RowOutcome[];
  warnings: PlanWarning[];
  accepted: AcceptedRecords;
  readCounts: Record<Entity, number>;
  reconciliation: Reconciliation;
}

export interface PlanOptions {
  /** Plan codes that do not require a payment (default: `free`). */
  freePlanCodes?: readonly string[];
  /** A payment may precede its subscription period by this many days (default 7). */
  paymentGraceDays?: number;
  /** A paid amount this many times above/below the currency median is an anomaly. */
  outlierFactor?: number;
}

const DAY = 86_400_000;

/** Deterministic ordering for legacy ids: numeric ids numerically, then lexical. */
export function compareIds(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function paymentIdempotencyKey(p: CanonicalPayment): string {
  return p.providerReference === null
    ? `payment:${p.provider}:legacy-${p.legacyId}`
    : `payment:${p.provider}:${p.providerReference}`;
}

type RawByEntity = Partial<Record<Entity, RawRecord[]>>;

/** Reads every mapped entity from a source (optionally only rows changed since a date). */
export async function readAll(
  source: LegacySource,
  options: ReadOptions = {},
): Promise<RawByEntity> {
  const out: RawByEntity = {};
  for (const entity of source.entities()) {
    const rows: RawRecord[] = [];
    for await (const row of source.read(entity, options)) rows.push(row);
    out[entity] = rows;
  }
  return out;
}

class Outcomes {
  private readonly byKey = new Map<string, RowOutcome>();

  set(
    entity: Entity,
    legacyId: string,
    status: RowStatus,
    reason?: string,
    details?: Record<string, string>,
  ) {
    const key = `${entity}\u0000${legacyId}`;
    const existing = this.byKey.get(key);
    if (existing === undefined) {
      this.byKey.set(key, {
        entity,
        legacyId,
        status,
        reasons: reason === undefined ? [] : [reason],
        ...(details === undefined ? {} : { details }),
      });
      return;
    }
    // Severity only escalates: accepted < conflict < rejected.
    const rank = { accepted: 0, conflict: 1, rejected: 2 } as const;
    if (rank[status] > rank[existing.status]) existing.status = status;
    if (reason !== undefined && !existing.reasons.includes(reason)) existing.reasons.push(reason);
    if (details !== undefined) existing.details = { ...existing.details, ...details };
  }

  status(entity: Entity, legacyId: string): RowStatus | undefined {
    return this.byKey.get(`${entity}\u0000${legacyId}`)?.status;
  }

  all(): RowOutcome[] {
    return [...this.byKey.values()]
      .map((o) => ({ ...o, reasons: [...o.reasons].sort() }))
      .sort(
        (a, b) =>
          ENTITIES.indexOf(a.entity) - ENTITIES.indexOf(b.entity) ||
          compareIds(a.legacyId, b.legacyId),
      );
  }
}

/**
 * Pure planning step: normalise, validate, deduplicate, detect conflicts and reconcile.
 * Same input → byte-identical output (all collections are sorted by legacy id).
 */
export function planRecords(raw: RawByEntity, mapping: Mapping, options: PlanOptions = {}): Plan {
  const freePlans = new Set(options.freePlanCodes ?? ['free']);
  const graceMs = (options.paymentGraceDays ?? 7) * DAY;
  const outlierFactor = options.outlierFactor ?? 10;
  const outcomes = new Outcomes();
  const warnings: PlanWarning[] = [];
  const readCounts = Object.fromEntries(ENTITIES.map((e) => [e, raw[e]?.length ?? 0])) as Record<
    Entity,
    number
  >;

  // 1. Normalise + validate + reject duplicate legacy ids.
  const valid = <E extends Entity>(entity: E): CanonicalByEntity[E][] => {
    const seen = new Map<string, CanonicalByEntity[E]>();
    (raw[entity] ?? []).forEach((row, index) => {
      const result = normalize(entity, row, mapping);
      if (!result.ok) {
        for (const reason of result.reasons) {
          outcomes.set(entity, result.legacyId ?? `#${index}`, 'rejected', reason);
        }
        return;
      }
      const id = result.record.legacyId;
      if (seen.has(id)) {
        outcomes.set(entity, id, 'rejected', 'duplicate_legacy_id');
        return;
      }
      seen.set(id, result.record);
      outcomes.set(entity, id, 'accepted');
      for (const warning of result.warnings) warnings.push({ entity, legacyId: id, warning });
    });
    return [...seen.values()].sort((a, b) => compareIds(a.legacyId, b.legacyId));
  };

  const users = valid('users');
  const subscriptions = valid('subscriptions');
  const payments = valid('payments');
  const projects = valid('projects');
  const files = valid('files');
  const telegramLinks = valid('telegramLinks');

  // 2. Users: e-mail is required (it is the login identity), dedup by e-mail and phone.
  const aliases = new Map<string, string>(); // duplicate legacy id → keeper legacy id
  const byEmail = new Map<string, CanonicalUser[]>();
  for (const user of users) {
    if (user.email === null) {
      outcomes.set('users', user.legacyId, 'rejected', 'missing_email');
      continue;
    }
    byEmail.set(user.email, [...(byEmail.get(user.email) ?? []), user]);
  }
  for (const group of byEmail.values()) {
    if (group.length < 2) continue;
    const phones = new Set(group.map((u) => u.phone).filter((p): p is string => p !== null));
    if (phones.size > 1) {
      const ids = group.map((u) => u.legacyId).join(',');
      for (const u of group) {
        outcomes.set('users', u.legacyId, 'conflict', 'same_email_different_phone', {
          email: maskEmail(u.email),
          group: ids,
        });
      }
      continue;
    }
    const [keeper, ...duplicates] = [...group].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareIds(a.legacyId, b.legacyId),
    );
    if (keeper === undefined) continue;
    for (const dup of duplicates) {
      aliases.set(dup.legacyId, keeper.legacyId);
      outcomes.set('users', dup.legacyId, 'rejected', 'duplicate_email', {
        duplicateOf: keeper.legacyId,
      });
    }
  }
  const byPhone = new Map<string, CanonicalUser[]>();
  for (const user of users) {
    if (user.phone === null || outcomes.status('users', user.legacyId) !== 'accepted') continue;
    byPhone.set(user.phone, [...(byPhone.get(user.phone) ?? []), user]);
  }
  for (const group of byPhone.values()) {
    if (new Set(group.map((u) => u.email)).size < 2) continue;
    const ids = group.map((u) => u.legacyId).join(',');
    for (const u of group) {
      outcomes.set('users', u.legacyId, 'conflict', 'same_phone_different_email', { group: ids });
    }
  }

  const resolveUser = (id: string | null) => (id === null ? null : (aliases.get(id) ?? id));
  const userStatus = (id: string | null) =>
    id === null ? undefined : outcomes.status('users', resolveUser(id) ?? id);
  /** Propagates the owning user's state to a child row. */
  const inheritUser = (entity: Entity, legacyId: string, userId: string | null) => {
    const status = userStatus(userId);
    if (status === undefined) {
      outcomes.set(
        entity,
        legacyId,
        entity === 'payments' ? 'conflict' : 'rejected',
        entity === 'payments' ? 'payment_without_user' : 'orphan_user',
      );
    } else if (status === 'conflict') {
      outcomes.set(entity, legacyId, 'conflict', 'user_in_conflict');
    } else if (status === 'rejected') {
      outcomes.set(entity, legacyId, 'rejected', 'user_rejected');
    }
  };

  // 3. Payments: user, provider reference dedup, amount anomalies.
  for (const p of payments) inheritUser('payments', p.legacyId, p.userLegacyId);
  const byReference = new Map<string, CanonicalPayment[]>();
  for (const p of payments) {
    if (p.providerReference === null) continue;
    const key = `${p.provider}\u0000${p.providerReference}`;
    byReference.set(key, [...(byReference.get(key) ?? []), p]);
  }
  for (const group of byReference.values()) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    if (first === undefined) continue;
    const identical = rest.every(
      (p) =>
        p.amountMinor === first.amountMinor &&
        p.currency === first.currency &&
        p.status === first.status &&
        resolveUser(p.userLegacyId) === resolveUser(first.userLegacyId),
    );
    if (identical) {
      for (const p of rest) {
        outcomes.set('payments', p.legacyId, 'rejected', 'duplicate_provider_reference', {
          duplicateOf: first.legacyId,
        });
      }
    } else {
      const ids = group.map((p) => p.legacyId).join(',');
      for (const p of group) {
        outcomes.set('payments', p.legacyId, 'conflict', 'provider_reference_conflict', {
          group: ids,
        });
      }
    }
  }
  const livePaid = () =>
    payments.filter(
      (p) => p.status === 'paid' && outcomes.status('payments', p.legacyId) !== 'rejected',
    );
  const amountsByCurrency = new Map<string, number[]>();
  for (const p of livePaid()) {
    if (p.amountMinor <= 0) {
      outcomes.set('payments', p.legacyId, 'conflict', 'amount_non_positive');
      continue;
    }
    amountsByCurrency.set(p.currency, [
      ...(amountsByCurrency.get(p.currency) ?? []),
      p.amountMinor,
    ]);
  }
  for (const p of livePaid()) {
    const sample = amountsByCurrency.get(p.currency) ?? [];
    if (sample.length < 3 || p.amountMinor <= 0) continue;
    const m = median(sample);
    if (p.amountMinor > m * outlierFactor || p.amountMinor * outlierFactor < m) {
      outcomes.set('payments', p.legacyId, 'conflict', 'amount_outlier', {
        currencyMedianMinor: String(m),
      });
    }
  }
  if (amountsByCurrency.size > 1) {
    // Not an error, but the reviewer must confirm every currency is expected.
    for (const currency of [...amountsByCurrency.keys()].sort()) {
      warnings.push({
        entity: 'payments',
        legacyId: '*',
        warning: `multiple_currencies:${currency}`,
      });
    }
  }

  // 4. Subscriptions: user, payment coverage, overlapping periods.
  for (const s of subscriptions) inheritUser('subscriptions', s.legacyId, s.userLegacyId);
  const subscriptionIds = new Set(subscriptions.map((s) => s.legacyId));
  const paymentById = new Map(payments.map((p) => [p.legacyId, p]));
  for (const p of payments) {
    if (p.subscriptionLegacyId !== null && !subscriptionIds.has(p.subscriptionLegacyId)) {
      warnings.push({ entity: 'payments', legacyId: p.legacyId, warning: 'unknown_subscription' });
    }
  }

  /** The subscription a paid payment pays for: explicit link, else period containment. */
  const coveringSubscription = (p: CanonicalPayment): CanonicalSubscription | undefined => {
    // A rejected subscription (orphan, invalid) cannot cover a payment.
    const candidates = subscriptions.filter(
      (s) => outcomes.status('subscriptions', s.legacyId) !== 'rejected',
    );
    if (p.subscriptionLegacyId !== null) {
      const explicit = candidates.find((s) => s.legacyId === p.subscriptionLegacyId);
      if (explicit !== undefined) return explicit;
    }
    const linked = candidates.find((s) => s.paymentLegacyId === p.legacyId);
    if (linked !== undefined) return linked;
    if (p.paidAt === null) return undefined;
    const paidAt = p.paidAt.getTime();
    const user = resolveUser(p.userLegacyId);
    return candidates.find(
      (s) =>
        resolveUser(s.userLegacyId) === user &&
        !freePlans.has(s.planCode) &&
        paidAt >= s.periodStart.getTime() - graceMs &&
        paidAt < s.periodEnd.getTime(),
    );
  };

  const paidLive = livePaid();
  const coverage = new Map<string, CanonicalSubscription>();
  for (const p of paidLive) {
    const s = coveringSubscription(p);
    if (s !== undefined) coverage.set(p.legacyId, s);
  }
  const paidSubscriptions = new Set([...coverage.values()].map((s) => s.legacyId));
  for (const s of subscriptions) {
    if (freePlans.has(s.planCode) || s.status === 'trialing') continue;
    if (outcomes.status('subscriptions', s.legacyId) === 'rejected') continue;
    const linked = s.paymentLegacyId === null ? undefined : paymentById.get(s.paymentLegacyId);
    if (!paidSubscriptions.has(s.legacyId) && linked?.status !== 'paid') {
      outcomes.set('subscriptions', s.legacyId, 'conflict', 'subscription_without_payment');
    }
  }

  const subsByUser = new Map<string, CanonicalSubscription[]>();
  for (const s of subscriptions) {
    if (outcomes.status('subscriptions', s.legacyId) === 'rejected') continue;
    const user = resolveUser(s.userLegacyId) ?? s.userLegacyId;
    subsByUser.set(user, [...(subsByUser.get(user) ?? []), s]);
  }
  for (const list of subsByUser.values()) {
    const sorted = [...list].sort(
      (a, b) =>
        a.periodStart.getTime() - b.periodStart.getTime() || compareIds(a.legacyId, b.legacyId),
    );
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (a === undefined || b === undefined) continue;
        if (b.periodStart.getTime() >= a.periodEnd.getTime()) break;
        outcomes.set('subscriptions', a.legacyId, 'conflict', 'overlapping_period', {
          overlapsWith: b.legacyId,
        });
        outcomes.set('subscriptions', b.legacyId, 'conflict', 'overlapping_period', {
          overlapsWith: a.legacyId,
        });
      }
    }
  }

  // 5. Research items, files and Telegram links follow their user.
  for (const p of projects) inheritUser('projects', p.legacyId, p.userLegacyId);
  const projectIds = new Set(projects.map((p) => p.legacyId));
  for (const f of files) {
    inheritUser('files', f.legacyId, f.userLegacyId);
    if (f.projectLegacyId !== null && !projectIds.has(f.projectLegacyId)) {
      warnings.push({ entity: 'files', legacyId: f.legacyId, warning: 'unknown_project' });
    }
    if (f.sha256 === null)
      warnings.push({ entity: 'files', legacyId: f.legacyId, warning: 'no_sha256' });
  }
  const telegramSeen = new Map<string, string>();
  for (const t of telegramLinks) {
    inheritUser('telegramLinks', t.legacyId, t.userLegacyId);
    const other = telegramSeen.get(t.telegramUserId);
    if (other !== undefined && resolveUser(other) !== resolveUser(t.userLegacyId)) {
      outcomes.set('telegramLinks', t.legacyId, 'conflict', 'telegram_id_linked_to_two_users');
      outcomes.set('telegramLinks', other, 'conflict', 'telegram_id_linked_to_two_users');
    }
    telegramSeen.set(t.telegramUserId, t.legacyId);
  }

  // 6. Financial reconciliation over paid/refunded payments that are not rejected.
  const buckets = new Map<string, ReconciliationRow>();
  const bucket = (currency: string, month: string) => {
    const key = `${currency}\u0000${month}`;
    let row = buckets.get(key);
    if (row === undefined) {
      row = {
        currency,
        month,
        paidCount: 0,
        paidTotalMinor: 0,
        matchedTotalMinor: 0,
        unmatchedTotalMinor: 0,
        refundedCount: 0,
        refundedTotalMinor: 0,
        coveredSubscriptionDays: 0,
      };
      buckets.set(key, row);
    }
    return row;
  };
  const coveredByBucket = new Map<string, Set<string>>();
  const unmatched: string[] = [];
  for (const p of payments) {
    if (outcomes.status('payments', p.legacyId) === 'rejected' || p.paidAt === null) continue;
    const row = bucket(p.currency, monthOf(p.paidAt));
    if (p.status === 'refunded') {
      row.refundedCount += 1;
      row.refundedTotalMinor += p.amountMinor;
      continue;
    }
    if (p.status !== 'paid') continue;
    row.paidCount += 1;
    row.paidTotalMinor += p.amountMinor;
    const s = coverage.get(p.legacyId);
    if (s === undefined) {
      row.unmatchedTotalMinor += p.amountMinor;
      unmatched.push(p.legacyId);
      continue;
    }
    row.matchedTotalMinor += p.amountMinor;
    const key = `${row.currency}\u0000${row.month}`;
    const seen = coveredByBucket.get(key) ?? new Set<string>();
    if (!seen.has(s.legacyId)) {
      seen.add(s.legacyId);
      row.coveredSubscriptionDays += Math.round(
        (s.periodEnd.getTime() - s.periodStart.getTime()) / DAY,
      );
    }
    coveredByBucket.set(key, seen);
  }
  const rows = [...buckets.values()].sort((a, b) =>
    a.currency === b.currency ? (a.month < b.month ? -1 : 1) : a.currency < b.currency ? -1 : 1,
  );
  const totals = new Map<string, { paidTotalMinor: number; unmatchedTotalMinor: number }>();
  for (const row of rows) {
    const t = totals.get(row.currency) ?? { paidTotalMinor: 0, unmatchedTotalMinor: 0 };
    t.paidTotalMinor += row.paidTotalMinor;
    t.unmatchedTotalMinor += row.unmatchedTotalMinor;
    totals.set(row.currency, t);
  }

  const isAccepted = (entity: Entity, id: string) => outcomes.status(entity, id) === 'accepted';
  const remap = <T extends { userLegacyId: string }>(r: T): T => ({
    ...r,
    userLegacyId: resolveUser(r.userLegacyId) ?? r.userLegacyId,
  });

  return {
    outcomes: outcomes.all(),
    warnings: warnings.sort(
      (a, b) =>
        ENTITIES.indexOf(a.entity) - ENTITIES.indexOf(b.entity) ||
        compareIds(a.legacyId, b.legacyId) ||
        (a.warning < b.warning ? -1 : a.warning > b.warning ? 1 : 0),
    ),
    accepted: {
      users: users.filter((u) => isAccepted('users', u.legacyId)),
      subscriptions: subscriptions
        .filter((s) => isAccepted('subscriptions', s.legacyId))
        .map(remap),
      payments: payments
        .filter((p) => isAccepted('payments', p.legacyId))
        .map((p) => ({ ...p, userLegacyId: resolveUser(p.userLegacyId) })),
      projects: projects.filter((p) => isAccepted('projects', p.legacyId)).map(remap),
      files: files.filter((f) => isAccepted('files', f.legacyId)).map(remap),
      telegramLinks: telegramLinks
        .filter((t) => isAccepted('telegramLinks', t.legacyId))
        .map(remap),
    },
    readCounts,
    reconciliation: {
      rows,
      totalsByCurrency: [...totals.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([currency, t]) => ({ currency, ...t })),
      unmatchedPayments: unmatched.sort(compareIds),
      paymentIdempotencyKeys: payments
        .filter((p) => outcomes.status('payments', p.legacyId) !== 'rejected')
        .map((p) => ({ legacyId: p.legacyId, key: paymentIdempotencyKey(p) })),
    },
  };
}

/** Dry run: reads the whole source, then plans. Writes nothing anywhere. */
export async function dryRun(
  source: LegacySource,
  mapping: Mapping,
  options: PlanOptions & ReadOptions = {},
): Promise<Plan> {
  const raw = await readAll(source, options.since === undefined ? {} : { since: options.since });
  return planRecords(raw, mapping, options);
}
