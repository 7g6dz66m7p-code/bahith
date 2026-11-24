# PostgreSQL backup and recovery

## Automated local drill

Run from the repository root:

```sh
pnpm --filter @bahith/db exec vitest run --config vitest.integration.config.ts test/integration/backup-restore.test.ts
```

The test creates disposable PostgreSQL 16 + pgvector clusters and synthetic users,
projects, Arabic source passages and private sessions. It captures a logical SQL database backup with
`pg_dump` and role definitions with `pg_dumpall --roles-only --no-role-passwords`.
It restores both into a separate empty cluster using `psql -v ON_ERROR_STOP=1`.
The test compares migration checksums and row security policies, checks private
session recovery, provisions fresh random credentials, and verifies that the
application connection sees only its bound workspace and cannot read sessions.
It also verifies that `migrateUp` reports no pending migrations after recovery.
Backup contents stay inside the disposable containers or test-process memory;
no SQL dump, password, session token or database URL is written to a tracked file.

The destination has a distinct bootstrap owner so restored source role definitions
do not collide with an existing role. This is a deliberate recovery prerequisite,
not a reason to ignore restore errors. Production role restoration must be reviewed
against the destination cluster before running it.

## Deployment requirements

Before a commercial release, configure and demonstrate all of the following on an
approved staging environment:

1. Provider-managed point-in-time recovery for the database, with an agreed RPO and
   retention period. Logical dumps alone do not provide continuous recovery.
2. Encrypted, access-controlled backups in a separate failure domain. Use a secret
   manager or protected `PGPASSFILE` for database credentials; never commit them or
   emit connection strings into logs. Backups contain private research and identity
   data even when role-password hashes are omitted.
3. Object-storage versioning or equivalent backup for uploaded originals and SANAD
   manifests. Preserve storage keys and SHA-256 values alongside database snapshots.
4. The deployed application revision, migration files and checksums, extraction and
   embedding model versions, and required private configuration. Better Auth's
   encryption secret is necessary to use restored encrypted TOTP material.
5. Automated monitoring of backup age and failures, plus periodic recovery drills
   with a recorded operator, timestamps, retained snapshot IDs and verification
   receipt. Agree owners and an escalation path before release.

## Recovery procedure

Use isolated infrastructure and obtain the necessary production authorization
before accessing a real backup. Restore into a new target instead of overwriting
an active database.

1. Select a mutually consistent database snapshot and object-storage snapshot, and
   record their creation times and expected data-loss window.
2. Prepare the same supported PostgreSQL major version and pgvector extension.
   Restore source role definitions without old login passwords; check owner roles,
   grants, security-definer function ownership and row security policies. Provision
   fresh application/auth credentials through the secret manager.
3. Restore the full database with fail-on-error enabled. Keep the application and
   background workers stopped until database and storage validation finish.
4. Check migration checksums, table and key record counts, immutable provenance,
   original-file and manifest hashes, and referenced object availability. Verify
   that the application role has neither SUPERUSER nor BYPASSRLS and owns no table.
5. Test two isolated users through actual login, project access, file download,
   SANAD retrieval and cross-user denial. Confirm decryption and recovery behavior
   for MFA accounts using controlled staging identities.
6. Reconcile queues against committed file-processing states before restarting
   workers. Redis queue contents are not an authoritative backup of research data.
7. Record elapsed recovery time, recovered snapshot time, failed checks and rollback
   path. Switch application traffic only after verification and approval.

## Limits of this evidence

The automated drill is small and local. It does not establish production RPO/RTO,
a production-size recovery time, point-in-time recovery, encrypted TOTP recovery,
object-storage recovery, queue recovery, geographic redundancy or a complete
application recovery. The two-hour recovery acceptance criterion still requires a
representative staging drill including object storage and the application.
