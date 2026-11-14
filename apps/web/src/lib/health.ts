export type CheckStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: Record<string, CheckStatus>;
}

export type HealthProbe = () => Promise<unknown>;

const DEFAULT_TIMEOUT_MS = 2_000;

async function probe(run: HealthProbe, timeoutMs: number): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('health probe timed out'));
    }, timeoutMs);
  });
  try {
    await Promise.race([run(), timeout]);
    return 'up';
  } catch {
    // Deliberately no detail: the report is public and must not leak internals.
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs every dependency probe in parallel, each bounded by a timeout.
 * The report only says which dependency is up or down.
 */
export async function checkHealth(
  probes: Record<string, HealthProbe>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HealthReport> {
  const names = Object.keys(probes);
  const results = await Promise.all(
    names.map(async (name) => {
      const run = probes[name];
      return [name, run ? await probe(run, timeoutMs) : 'down'] as const;
    }),
  );
  const checks = Object.fromEntries(results);
  const healthy = results.every(([, status]) => status === 'up');
  return { status: healthy ? 'ok' : 'degraded', checks };
}
