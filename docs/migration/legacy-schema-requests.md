# App-schema requests for the legacy migration (for the lead)

`packages/migration` adds **no migration** to `packages/db`. Today it works without
app-schema changes: identities, projects and subscriptions use existing tables; its
bookkeeping lives in a tool-owned `bahith_migration` schema (created by the operator
connection, `REVOKE ALL ... FROM PUBLIC`, never granted to `bahith_app`/`bahith_auth`).
The items below would let apply mode stop deferring data. Numbering is yours.

## 1. `users.legacy_id` (traceability; optional if the ledger is kept)

Drizzle (`packages/db/src/schema/identity.ts`, `users` columns + extras):

```ts
legacyId: text('legacy_id'),
// extras:
uniqueIndex('users_legacy_id_key').on(t.legacyId).where(sql`${t.legacyId} is not null`),
```

```sql
-- up
ALTER TABLE users ADD COLUMN legacy_id text;
CREATE UNIQUE INDEX users_legacy_id_key ON users (legacy_id) WHERE legacy_id IS NOT NULL;
-- down
DROP INDEX users_legacy_id_key;
ALTER TABLE users DROP COLUMN legacy_id;
```

Expand-only, nullable, no backfill needed. `bahith_auth` already has UPDATE on `users`.

## 2. `telegram_links` (replaces the ledger lookup used by `LedgerTelegramLinkStore`)

Identity-level, so owned by the auth role like `accounts` (not a tenant table).

```ts
export const telegramLinks = pgTable(
  'telegram_links',
  {
    telegramUserId: text('telegram_user_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull(), // 'legacy_migration' | 'login_widget' | 'web_app'
  },
  (t) => [
    index('telegram_links_user_id_idx').on(t.userId),
    check('telegram_links_id_digits', sql`${t.telegramUserId} ~ '^[1-9][0-9]{0,19}$'`),
    pgPolicy('telegram_links_auth_manage', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: sql`current_user = 'bahith_auth'`,
      withCheck: sql`current_user = 'bahith_auth'`,
    }),
  ],
);
```

```sql
-- up
CREATE TABLE telegram_links (
  telegram_user_id text PRIMARY KEY CHECK (telegram_user_id ~ '^[1-9][0-9]{0,19}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL
);
CREATE INDEX telegram_links_user_id_idx ON telegram_links (user_id);
ALTER TABLE telegram_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_links FORCE ROW LEVEL SECURITY;
CREATE POLICY telegram_links_auth_manage ON telegram_links FOR ALL TO public
  USING (current_user = 'bahith_auth') WITH CHECK (current_user = 'bahith_auth');
GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_links TO bahith_auth;
-- down
DROP TABLE telegram_links;
```

## 3. `legacy_payments` (financial history; currently `deferred`)

Tenant table (`workspace_id` + `tenantExtras` → RLS + isolation test coverage automatically).

```ts
export const legacyPayments = pgTable(
  'legacy_payments',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    legacyId: text('legacy_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    provider: text('provider').notNull(),
    providerReference: text('provider_reference'),
    status: text('status').notNull(), // paid | pending | failed | refunded
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    ...tenantExtras('legacy_payments', t),
    unique('legacy_payments_legacy_id_key').on(t.legacyId),
    uniqueIndex('legacy_payments_provider_ref_key')
      .on(t.provider, t.providerReference)
      .where(sql`${t.providerReference} is not null`),
    check('legacy_payments_currency', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);
```

```sql
-- up (plus the standard tenant RLS policies emitted by tenantExtras)
CREATE TABLE legacy_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  legacy_id text NOT NULL UNIQUE,
  amount_minor bigint NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider text NOT NULL,
  provider_reference text,
  status text NOT NULL CHECK (status IN ('paid','pending','failed','refunded')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX legacy_payments_provider_ref_key ON legacy_payments (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
GRANT SELECT ON legacy_payments TO bahith_app;  -- read-only history; writes by the migration operator
-- down
DROP TABLE legacy_payments;
```

## 4. Files (currently `deferred`)

Legacy files need a storage copy (download from legacy storage → S3/MinIO → `registerUpload`
→ worker extraction). That is a separate, owner-approved job; no schema change requested yet
beyond `files` already existing. `sha256` from the legacy side (when present) feeds the
existing library dedup.

## 5. Decision needed

- Keep `bahith_migration` as a tool-owned schema in production (who owns it, retention), or
  move ledger rows into the tables above and drop it after cut-over.
