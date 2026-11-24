import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Entity } from './canonical';
import { currencyExponent, ENTITIES } from './canonical';
import type { Plan, RowOutcome } from './planner';

export interface ReportMeta {
  /** ISO timestamp; passed in so the report is reproducible in tests. */
  generatedAt: string;
  sourceKind: string;
  mode: 'dry-run';
}

export interface MigrationReport {
  meta: ReportMeta;
  counts: Record<Entity, { read: number; accepted: number; rejected: number; conflict: number }>;
  reasons: { entity: Entity; reason: string; count: number }[];
  rows: RowOutcome[];
  warnings: Plan['warnings'];
  reconciliation: Plan['reconciliation'];
}

/**
 * The report contains legacy ids, reason codes, masked e-mails and amounts only —
 * never names, raw e-mails, phone numbers, titles or file paths.
 */
export function buildReport(plan: Plan, meta: ReportMeta): MigrationReport {
  const counts = Object.fromEntries(
    ENTITIES.map((entity) => {
      const rows = plan.outcomes.filter((o) => o.entity === entity);
      return [
        entity,
        {
          read: plan.readCounts[entity],
          accepted: rows.filter((o) => o.status === 'accepted').length,
          rejected: rows.filter((o) => o.status === 'rejected').length,
          conflict: rows.filter((o) => o.status === 'conflict').length,
        },
      ];
    }),
  ) as MigrationReport['counts'];
  const reasonCounts = new Map<string, number>();
  for (const o of plan.outcomes) {
    for (const reason of o.reasons) {
      const key = `${o.entity}\u0000${reason}`;
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
  }
  const reasons = [...reasonCounts.entries()]
    .map(([key, count]) => {
      const [entity, reason] = key.split('\u0000') as [Entity, string];
      return { entity, reason, count };
    })
    .sort(
      (a, b) =>
        ENTITIES.indexOf(a.entity) - ENTITIES.indexOf(b.entity) ||
        (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
    );
  return {
    meta,
    counts,
    reasons,
    rows: plan.outcomes,
    warnings: plan.warnings,
    reconciliation: plan.reconciliation,
  };
}

export function formatMinor(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const sign = amountMinor < 0 ? '-' : '';
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, '0');
  const major =
    exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  return `${sign}${major} ${currency}`;
}

export function reportToMarkdown(report: MigrationReport): string {
  const lines: string[] = [
    '# تقرير الترحيل التجريبي (Dry run) — Legacy migration report',
    '',
    `- generated_at: ${report.meta.generatedAt}`,
    `- source: ${report.meta.sourceKind}`,
    `- mode: ${report.meta.mode} (لم يُكتب أي شيء / nothing was written)`,
    '',
    '## الأعداد لكل كيان / Counts per entity',
    '',
    '| entity | read | accepted | rejected | conflict |',
    '| --- | --- | --- | --- | --- |',
    ...ENTITIES.map((e) => {
      const c = report.counts[e];
      return `| ${e} | ${c.read} | ${c.accepted} | ${c.rejected} | ${c.conflict} |`;
    }),
    '',
    '## الأسباب / Reasons',
    '',
    '| entity | reason | rows |',
    '| --- | --- | --- |',
    ...report.reasons.map((r) => `| ${r.entity} | ${r.reason} | ${r.count} |`),
    '',
    '## الصفوف المرفوضة والمتعارضة / Rejected and conflicting rows',
    '',
    '| entity | legacy_id | status | reasons | details |',
    '| --- | --- | --- | --- | --- |',
    ...report.rows
      .filter((r) => r.status !== 'accepted')
      .map((r) => {
        const details = Object.entries(r.details ?? {})
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
        return `| ${r.entity} | ${r.legacyId} | ${r.status} | ${r.reasons.join(', ')} | ${details} |`;
      }),
    '',
    '## التحذيرات / Warnings',
    '',
    ...(report.warnings.length === 0
      ? ['- none']
      : report.warnings.map((w) => `- ${w.entity} ${w.legacyId}: ${w.warning}`)),
    '',
    '## المطابقة المالية / Financial reconciliation',
    '',
    '| currency | month | paid | paid total | matched | unmatched | refunded | covered days |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.reconciliation.rows.map(
      (r) =>
        `| ${r.currency} | ${r.month} | ${r.paidCount} | ${formatMinor(r.paidTotalMinor, r.currency)} | ${formatMinor(r.matchedTotalMinor, r.currency)} | ${formatMinor(r.unmatchedTotalMinor, r.currency)} | ${r.refundedCount} (${formatMinor(r.refundedTotalMinor, r.currency)}) | ${r.coveredSubscriptionDays} |`,
    ),
    '',
    '### الإجماليات / Totals',
    '',
    ...report.reconciliation.totalsByCurrency.map(
      (t) =>
        `- ${t.currency}: paid ${formatMinor(t.paidTotalMinor, t.currency)}, unmatched ${formatMinor(t.unmatchedTotalMinor, t.currency)}`,
    ),
    '',
    '### مدفوعات غير مطابقة / Unmatched payments',
    '',
    report.reconciliation.unmatchedPayments.length === 0
      ? '- none'
      : `- ${report.reconciliation.unmatchedPayments.join(', ')}`,
    '',
    '### مفاتيح عدم التكرار / Idempotency keys',
    '',
    'Other entities use `<entity>:<legacy_id>`. Payments:',
    '',
    ...report.reconciliation.paymentIdempotencyKeys.map((k) => `- ${k.legacyId} → \`${k.key}\``),
    '',
  ];
  return lines.join('\n');
}

export async function writeReport(
  report: MigrationReport,
  outDir: string,
): Promise<{ json: string; markdown: string }> {
  await mkdir(outDir, { recursive: true });
  const json = join(outDir, 'migration-report.json');
  const markdown = join(outDir, 'migration-report.md');
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdown, reportToMarkdown(report), 'utf8');
  return { json, markdown };
}
