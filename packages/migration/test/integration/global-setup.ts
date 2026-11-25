import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { POSTGRES_IMAGE, seedReferenceData, startTestDatabase } from '@bahith/db/testing';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

import { legacyDump } from '../fixtures';

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    appUrl: string;
    authUrl: string;
    legacyReaderUrl: string;
    legacyAdminUrl: string;
  }
}

/**
 * ASSUMED legacy schema — invented for the tests; the real legacy schema is unknown.
 * Column types are chosen to exercise driver conversions (numeric → string,
 * bigint → string, timestamptz → Date, serial → number).
 */
const ASSUMED_LEGACY_DDL = `
CREATE SCHEMA legacy;
CREATE TABLE legacy.members (id integer PRIMARY KEY, email text, mobile text, full_name text,
  created_on timestamptz NOT NULL, updated_on timestamptz NOT NULL);
CREATE TABLE legacy.plans_subs (id integer PRIMARY KEY, member_id integer, plan text, state text,
  starts_at timestamptz, ends_at timestamptz, payment_id integer, updated_on timestamptz NOT NULL);
CREATE TABLE legacy.transactions (id integer PRIMARY KEY, member_id integer, sub_id integer,
  amount numeric(14,3), currency char(3), gateway text, gateway_ref text, state text,
  paid_on timestamptz, updated_on timestamptz NOT NULL);
CREATE TABLE legacy.researches (id integer PRIMARY KEY, member_id integer, title text, question text,
  lang text, created_on timestamptz NOT NULL, updated_on timestamptz NOT NULL);
CREATE TABLE legacy.uploads (id integer PRIMARY KEY, member_id integer, research_id integer, path text,
  checksum text, mime text, size bigint, updated_on timestamptz NOT NULL);
CREATE TABLE legacy.tg_users (tg_id bigint PRIMARY KEY, member_id integer, updated_on timestamptz NOT NULL);
`;

async function seedLegacy(adminUrl: string, readerPassword: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(ASSUMED_LEGACY_DDL);
    for (const [table, rows] of Object.entries(legacyDump)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        await client.query(
          `INSERT INTO legacy.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(row),
        );
      }
    }
    // The migration reads through a SELECT-only role, as on the owner's replica.
    await client.query(`CREATE ROLE legacy_reader LOGIN PASSWORD '${readerPassword}'`);
    await client.query('GRANT USAGE ON SCHEMA legacy TO legacy_reader');
    await client.query('GRANT SELECT ON ALL TABLES IN SCHEMA legacy TO legacy_reader');
  } finally {
    await client.end();
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [bahith, legacy] = await Promise.all([
    startTestDatabase(),
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
  ]);
  const admin = new pg.Client({ connectionString: bahith.adminUrl });
  await admin.connect();
  try {
    await seedReferenceData(admin);
  } finally {
    await admin.end();
  }

  const legacyAdminUrl = legacy.getConnectionUri();
  // Throwaway password inside a disposable container.
  const readerPassword = crypto.randomUUID().replace(/-/g, '');
  await seedLegacy(legacyAdminUrl, readerPassword);
  const reader = new URL(legacyAdminUrl);
  reader.username = 'legacy_reader';
  reader.password = readerPassword;

  project.provide('adminUrl', bahith.adminUrl);
  project.provide('appUrl', bahith.appUrl);
  project.provide('authUrl', bahith.authUrl);
  project.provide('legacyReaderUrl', reader.toString());
  project.provide('legacyAdminUrl', legacyAdminUrl);
  return async () => {
    await Promise.all([bahith.stop(), legacy.stop()]);
  };
}
