/**
 * Prepares a real signed-in researcher on the local e2e harness for load testing:
 * sign-up, email verification through the harness's Mailpit, sign-in, a project, and
 * one uploaded synthetic source processed by the real workers. Prints k6 variables.
 * Local only: refuses any base URL that is not localhost.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.LOAD_BASE_URL ?? 'http://localhost:3100';
// Local stacks, or a staging host (never the production domain): it creates test accounts.
if (!/^(http:\/\/(localhost|127\.0\.0\.1):\d+|https:\/\/staging\.[a-z0-9.-]+)$/u.test(BASE)) {
  throw new Error('local or staging stacks only');
}
// The staging stack passes its own Mailpit (LOAD_MAIL_URL); the e2e harness writes its own.
const runtime =
  process.env.LOAD_MAIL_URL === undefined
    ? (JSON.parse(
        await readFile(path.resolve(import.meta.dirname, '../.next/e2e-runtime.json'), 'utf8'),
      ) as { mailUrl: string })
    : { mailUrl: process.env.LOAD_MAIL_URL };
const origin = { origin: BASE, 'content-type': 'application/json' };
const email = `load-${crypto.randomUUID()}@example.test`;
const password = `Load-${crypto.randomUUID()}`;

let response = await fetch(`${BASE}/api/auth/sign-up/email`, {
  method: 'POST',
  headers: origin,
  body: JSON.stringify({ name: 'Load test', email, password, callbackURL: `${BASE}/ar/dashboard` }),
});
if (!response.ok) throw new Error(`sign-up ${String(response.status)}`);
let link: string | undefined;
for (let i = 0; i < 40 && link === undefined; i += 1) {
  const list = (await (await fetch(`${runtime.mailUrl}/api/v1/messages`)).json()) as {
    messages: { ID: string; To: { Address: string }[] }[];
  };
  const message = list.messages.find((m) => m.To.some((to) => to.Address === email));
  if (message !== undefined) {
    const body = (await (
      await fetch(`${runtime.mailUrl}/api/v1/message/${message.ID}`)
    ).json()) as { Text: string };
    link = /https?:\/\/\S+/u.exec(body.Text)?.[0];
  }
  if (link === undefined) await new Promise((resolve) => setTimeout(resolve, 500));
}
if (link === undefined) throw new Error('no verification email');
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
