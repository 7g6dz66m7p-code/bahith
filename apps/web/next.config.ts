import { existsSync } from 'node:fs';
import path from 'node:path';

import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Next.js only reads .env files next to the app; the monorepo keeps a single .env at
// the repository root. Variables already present in the environment are not overridden.
const rootEnv = path.resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources; Next compiles them.
  transpilePackages: ['@bahith/db', '@bahith/auth'],
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
};

export default withNextIntl(nextConfig);
