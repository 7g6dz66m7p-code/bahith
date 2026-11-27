/**
 * Prepares a real signed-in researcher on the local e2e harness for load testing:
 * sign-up, email verification through the harness's Mailpit, sign-in, a project, and
 * one uploaded synthetic source processed by the real workers. Prints k6 variables.
 * Test stacks only (local, staging or a preview branch): see remote.ts.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertTestStack,
  installProtectionBypass,
  testRecipient,
  verificationLink,
} from './remote';

const BASE = process.env.LOAD_BASE_URL ?? 'http://localhost:3100';
assertTestStack(BASE);
installProtectionBypass(BASE);
// The staging stack passes its own Mailpit (LOAD_MAIL_URL); the e2e harness writes its own.
// A preview reads the e-mail from Resend instead (LOAD_MAIL_PROVIDER=resend).
const mailUrl = async () =>
  process.env.LOAD_MAIL_URL ??
  (
    JSON.parse(
      await readFile(path.resolve(import.meta.dirname, '../.next/e2e-runtime.json'), 'utf8'),
    ) as { mailUrl: string }
  ).mailUrl;
const origin = { origin: BASE, 'content-type': 'application/json' };
const email = testRecipient();
const password = `Load-${crypto.randomUUID()}`;

let response = await fetch(`${BASE}/api/auth/sign-up/email`, {
  method: 'POST',
  headers: origin,
  body: JSON.stringify({ name: 'Load test', email, password, callbackURL: `${BASE}/ar/dashboard` }),
});
if (!response.ok) throw new Error(`sign-up ${String(response.status)}`);
const link = await verificationLink(email, mailUrl);
if (new URL(link).origin !== new URL(BASE).origin) throw new Error('verification link host');
await fetch(link, { redirect: 'manual' });
response = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: origin,
  body: JSON.stringify({ email, password }),
});
const cookie = response.headers
  .getSetCookie()
  .map((value) => value.split(';')[0])
  .join('; ');
if (!response.ok || cookie === '') throw new Error('sign-in failed');
const auth = { ...origin, cookie };
const { workspaces } = (await (await fetch(`${BASE}/api/projects`, { headers: auth })).json()) as {
  workspaces: { id: string }[];
};
const workspaceId = workspaces[0]?.id ?? '';
const { project } = (await (
  await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ workspaceId, title: 'مشروع اختبار الحمل', language: 'ar' }),
  })
).json()) as { project: { id: string } };

const pdf = await readFile(
  path.resolve(import.meta.dirname, '../../../eval/sanad/corpus/ar-elearning.pdf'),
);
const form = new FormData();
form.set('file', new File([pdf], 'ar-elearning.pdf', { type: 'application/pdf' }));
response = await fetch(`${BASE}/api/projects/${project.id}/sources?workspaceId=${workspaceId}`, {
  method: 'POST',
  headers: { origin: BASE, cookie },
  body: form,
});
if (!response.ok) throw new Error(`upload ${String(response.status)}`);
let ready = false;
for (let i = 0; i < 180 && !ready; i += 1) {
  const library = (await (
    await fetch(`${BASE}/api/projects/${project.id}/sources?workspaceId=${workspaceId}`, {
      headers: auth,
    })
  ).json()) as { sources: { files: { status: string }[] }[] };
  const status = library.sources[0]?.files[0]?.status;
  if (status === 'failed') throw new Error('processing failed');
  ready = status === 'ready';
  if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!ready) throw new Error('processing did not finish in 180 s');
process.stdout.write(
  JSON.stringify({ BASE, COOKIE: cookie, WORKSPACE_ID: workspaceId, PROJECT_ID: project.id }),
);
