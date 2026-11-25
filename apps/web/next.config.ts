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

// Security headers (checked by the ZAP baseline scan, docs/runbooks/load-security.md).
// Inline bootstrap scripts of Next.js need 'unsafe-inline' unless every page renders
// with per-request nonces; the policy still blocks third-party scripts, framing,
// plugins and foreign form targets. Development adds 'unsafe-eval' for hot reload only.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

const nextConfig: NextConfig = {
  headers() {
    return Promise.resolve([
      { source: '/:path*', headers: securityHeaders },
      // Pages only: API responses (JSON, or a PDF opened in the browser viewer) keep
      // their own headers, e.g. the CSP sandbox the file route sets for non-PDF types.
      {
        source: '/((?!api/).*)',
        headers: [{ key: 'Content-Security-Policy', value: contentSecurityPolicy }],
      },
    ]);
  },
  // Workspace packages ship TypeScript sources; Next compiles them.
  transpilePackages: ['@bahith/db', '@bahith/auth'],
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
};

export default withNextIntl(nextConfig);
