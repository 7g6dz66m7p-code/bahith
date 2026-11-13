import type { TestProject } from 'vitest/node';

import { startTestDatabase } from '../../src/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    appUrl: string;
  }
}

/** One Postgres 16 + pgvector container, migrated, shared by the integration suite. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await startTestDatabase();
  project.provide('adminUrl', database.adminUrl);
  project.provide('appUrl', database.appUrl);
  return () => database.stop();
}
