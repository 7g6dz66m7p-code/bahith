#!/usr/bin/env node
/** Passive authenticated ZAP baseline against synthetic local data only. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(
  await readFile(path.join(root, 'apps/web/.next/readiness-users.json'), 'utf8'),
);
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(fixture.baseUrl)) {
  throw new Error('ZAP baseline requires the isolated local test server');
}
if (!process.env.ZAP_JAR) throw new Error('ZAP_JAR must name the installed ZAP jar');
const outDir = path.join(root, 'apps/web/test-results/readiness');
await mkdir(outDir, { recursive: true });
const zapHome = path.join(root, 'apps/web/.next/zap-home');
await mkdir(zapHome, { recursive: true, mode: 0o700 });
const apiKey = randomUUID();
const apiBase = 'http://127.0.0.1:3201/JSON';
const child = spawn(
  'java',
  [
    '-Xmx512m',
    '-jar',
    process.env.ZAP_JAR,
    '-daemon',
    '-silent',
    '-host',
    '127.0.0.1',
    '-port',
    '3201',
    '-dir',
    zapHome,
    '-config',
    `api.key=${apiKey}`,
    '-config',
    'api.addrs.addr.name=127.0.0.1',
    '-config',
    'api.addrs.addr.regex=false',
  ],
  { stdio: 'ignore' },
);
let exited = false;
child.once('exit', () => {
  exited = true;
});
async function api(component, operation, action, values = {}) {
  const params = new URLSearchParams({ apikey: apiKey, ...values });
  const response = await fetch(`${apiBase}/${component}/${operation}/${action}/?${params}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`ZAP ${component}/${action} failed: HTTP ${response.status}`);
  const result = await response.json();
  if (result.code) throw new Error(`ZAP ${component}/${action}: ${result.code}`);
  return result;
}
function sanitize(value) {
  let text = JSON.stringify(value, null, 2);
  for (const user of fixture.users) {
    text = text.replaceAll(user.cookie, '[REDACTED SESSION]');
    for (const pair of user.cookie.split('; ')) {
      const token = pair.slice(pair.indexOf('=') + 1);
      if (token.length > 8) text = text.replaceAll(token, '[REDACTED SESSION]');
    }
  }
  return text.replaceAll(apiKey, '[REDACTED ZAP API KEY]');
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (exited)
      throw new Error('ZAP exited before startup; inspect its private .next/zap-home log');
    try {
      await api('core', 'view', 'version');
      ready = true;
      break;
    } catch {
      await delay(500);
    }
  }
  if (!ready) throw new Error('ZAP did not become ready');
  const version = await api('core', 'view', 'version');
  const origin = fixture.baseUrl;
  const own = fixture.users[0];
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await api('replacer', 'action', 'addRule', {
    description: 'Synthetic local user session',
    enabled: 'true',
    matchType: 'REQ_HEADER',
    matchRegex: 'false',
    matchString: 'Cookie',
    replacement: own.cookie,
    initiators: '',
    url: `${escapedOrigin}/.*`,
  });
  await api('spider', 'action', 'setOptionMaxDuration', { Integer: '1' });
  await api('spider', 'action', 'setOptionMaxDepth', { Integer: '5' });
  await api('spider', 'action', 'setOptionThreadCount', { Integer: '2' });
  for (const route of [
    '/ar',
    '/en',
    '/en/dashboard',
    '/api/projects',
    `/en/workspaces/${own.workspaceId}/projects/${own.projectId}`,
  ]) {
    await api('core', 'action', 'accessUrl', { url: `${origin}${route}`, followRedirects: 'true' });
  }
  const authenticated = await api('core', 'view', 'messages', {
    baseurl: `${origin}/api/projects`,
    start: '0',
    count: '100',
  });
  if (
    !authenticated.messages.some(
      (message) =>
        /^HTTP\/1\.[01] 200/u.test(message.responseHeader) &&
        message.responseBody.includes(own.projectId),
    )
  ) {
    throw new Error('ZAP did not observe the authenticated project response');
  }
  const scan = await api('spider', 'action', 'scan', {
    url: `${origin}/en/dashboard`,
    recurse: 'true',
    subtreeOnly: 'false',
  });
  let scanned = false;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const status = await api('spider', 'view', 'status', { scanId: scan.scan });
    if (status.status === '100') {
      scanned = true;
      break;
    }
    await delay(500);
  }
  if (!scanned) throw new Error('ZAP spider did not finish');
  let drained = false;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const pending = await api('pscan', 'view', 'recordsToScan');
    if (pending.recordsToScan === '0') {
      drained = true;
      break;
    }
    await delay(500);
  }
  if (!drained) throw new Error('ZAP passive scanning did not drain');
  const alerts = await api('core', 'view', 'alerts', {
    baseurl: origin,
    start: '0',
    count: '10000',
  });
  const urls = await api('core', 'view', 'urls', { baseurl: origin });
  const high = alerts.alerts.filter((alert) => Number(alert.risk) >= 3 || alert.risk === 'High');
  const medium = alerts.alerts.filter(
    (alert) => Number(alert.risk) === 2 || alert.risk === 'Medium',
  );
  const summary = {
    tool: 'OWASP ZAP',
    version: version.version,
    mode: 'authenticated passive baseline',
    visitedUrls: urls.urls.length,
    authenticatedProjectVerified: true,
    alertCount: alerts.alerts.length,
    high: high.length,
    medium: medium.length,
    alerts: alerts.alerts.map(
      ({ pluginId, name, risk, confidence, url, param, evidence, solution }) => ({
        pluginId,
        name,
        risk,
        confidence,
        url,
        param,
        evidence,
        solution,
      }),
    ),
  };
  await writeFile(path.join(outDir, 'zap-baseline.json'), sanitize(summary), { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      version: version.version,
      visitedUrls: urls.urls.length,
      alerts: alerts.alerts.length,
      high: high.length,
      medium: medium.length,
    }) + '\n',
  );
  if (high.length > 0 || medium.length > 0) process.exitCode = 1;
} finally {
  try {
    await api('core', 'action', 'shutdown');
  } catch {
    child.kill('SIGTERM');
  }
}
