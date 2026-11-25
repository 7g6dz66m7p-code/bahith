import { appendFileSync } from 'node:fs';

/**
 * CI helper: rebuilds DATABASE_URL and AUTH_DATABASE_URL from DATABASE_ADMIN_URL's host,
 * database and parameters, the fixed role names, and ONLY the passwords of the given
 * secrets. A hand-edited host can then never point the roles at the wrong server.
 * Values are masked first (GitHub workflow command), then exported through GITHUB_ENV.
 * Prints which parts of the given URLs were replaced, by name only.
 */
const adminRaw = process.env.DATABASE_ADMIN_URL ?? '';
const githubEnv = process.env.GITHUB_ENV;
if (githubEnv === undefined) throw new Error('GITHUB_ENV is not set (CI only)');
const out: string = githubEnv;
const admin = new URL(adminRaw);

function rebuild(name: 'DATABASE_URL' | 'AUTH_DATABASE_URL', role: string): void {
  // CI passes the secrets as SECRET_<NAME> so the rebuilt value is the only <NAME>.
  const given = process.env[`SECRET_${name}`] ?? process.env[name] ?? '';
  let password = '';
  const replaced: string[] = [];
  try {
    const url = new URL(given);
    password = url.password;
    if (decodeURIComponent(url.username) !== role) replaced.push('user');
    if (url.hostname !== admin.hostname) replaced.push('host');
    if (url.port !== admin.port) replaced.push('port');
    if (url.pathname !== admin.pathname) replaced.push('database');
    if (url.search !== admin.search) replaced.push('parameters');
  } catch {
    // Not a valid URL (e.g. a hand-edited host): take only the password between
    // "<user>:" and "@"; anything else in the secret is ignored.
    const match = /^postgres(?:ql)?:\/\/[^:/@\s]+:([^@\s]+)@/u.exec(given);
    password = match?.[1] ?? '';
    replaced.push('everything except the password (the secret is not a valid URL)');
  }
  if (password === '') throw new Error(`${name}: no password found in the secret`);
  const url = new URL(admin.toString());
  url.username = role;
  url.password = password;
  const value = url.toString();
  process.stdout.write(`::add-mask::${value}\n`);
  appendFileSync(out, `${name}=${value}\n`);
  process.stdout.write(
    `${name}: role ${role}, password from the secret` +
      (replaced.length > 0 ? `; replaced from DATABASE_ADMIN_URL: ${replaced.join(', ')}` : '') +
      '\n',
  );
}

rebuild('DATABASE_URL', 'bahith_app');
rebuild('AUTH_DATABASE_URL', 'bahith_auth');
