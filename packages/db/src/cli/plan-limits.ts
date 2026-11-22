import pg from 'pg';
import { z } from 'zod';

import { loadCliEnv, runCli } from './env';

/**
 * pnpm db:plan-limits -- --plan=free --ai-requests-per-month=50
 * Sets one numeric limit of a plan (admin role; plans are read-only for the app). The
 * values are the project owner's decision; nothing is granted until one is set.
 */
const METRICS = { '--ai-requests-per-month=': 'ai_requests_per_month' } as const;

runCli(async () => {
  const argv = process.argv.slice(2);
  const env = loadCliEnv(argv);
  const plan = z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/u)
    .parse(argv.find((arg) => arg.startsWith('--plan='))?.slice('--plan='.length));
  const updates: Record<string, number> = {};
  for (const [flag, metric] of Object.entries(METRICS)) {
    const raw = argv.find((arg) => arg.startsWith(flag))?.slice(flag.length);
    if (raw !== undefined)
      updates[metric] = z.coerce.number().int().min(0).max(1_000_000).parse(raw);
  }
  if (Object.keys(updates).length === 0)
    throw new Error('Pass at least one limit, e.g. --ai-requests-per-month=50.');
  const client = new pg.Client({ connectionString: env.adminUrl });
  await client.connect();
  try {
    const result = await client.query<{ limits: Record<string, number> }>(
      'UPDATE plans SET limits = limits || $2::jsonb, updated_at = now() WHERE code = $1 RETURNING limits',
      [plan, JSON.stringify(updates)],
    );
    if (result.rowCount === 0) throw new Error(`No plan with code "${plan}".`);
    process.stdout.write(`Plan ${plan} limits: ${JSON.stringify(result.rows[0]?.limits)}\n`);
  } finally {
    await client.end();
  }
});
