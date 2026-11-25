import type pg from 'pg';

/**
 * Reference data every environment needs: the plan catalogue (free + one paid plan).
 *
 * `limits` is intentionally empty: a metric without a limit is treated as "not allowed",
 * so nothing is granted until the project owner decides the real quotas.
 * Idempotent. Runs as the admin role (plans are read-only for the application role).
 */
export async function seedReferenceData(client: pg.ClientBase): Promise<void> {
  await client.query(
    `INSERT INTO plans (code, name, limits)
     VALUES ('free', 'Free', '{}'::jsonb), ('pro', 'Pro', '{}'::jsonb)
     ON CONFLICT (code) DO NOTHING`,
  );
}
