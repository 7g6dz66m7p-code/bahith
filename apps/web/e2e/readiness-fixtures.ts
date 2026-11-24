/** Creates synthetic fixtures only, through the real auth, SMTP, upload and worker APIs. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createDatabase } from '@bahith/db';
import { z } from 'zod';

const appDir = path.resolve(import.meta.dirname, '..');
const runtimePath =
  process.env.BAHITH_TEST_RUNTIME_FILE ?? path.join(appDir, '.next/e2e-runtime.json');
const outputPath = path.join(appDir, '.next/readiness-users.json');
const runtime = z
  .object({ baseUrl: z.url(), mailUrl: z.url(), authUrl: z.url() })
  .parse(JSON.parse(await readFile(runtimePath, 'utf8')));
if (!['localhost', '127.0.0.1'].includes(new URL(runtime.baseUrl).hostname)) {
  throw new Error('Readiness fixtures require an isolated local test server');
}
const authDatabase = createDatabase({ connectionString: runtime.authUrl });
const users: { cookie: string; workspaceId: string; projectId: string; marker: string }[] = [];
const origin = runtime.baseUrl;
function requireStatus(response: Response, status: number, operation: string) {
  if (response.status !== status)
    throw new Error(`${operation}: expected ${status}, got ${response.status}`);
}
async function verificationUrl(email: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const messages = z
      .object({
        messages: z.array(
          z.object({ ID: z.string(), To: z.array(z.object({ Address: z.string() })) }),
        ),
      })
      .parse(await (await fetch(`${runtime.mailUrl}/api/v1/messages?limit=200`)).json());
    const found = messages.messages.find((message) =>
      message.To.some((to) => to.Address === email),
    );
    if (found !== undefined) {
      const message = z
        .object({ Text: z.string() })
        .parse(await (await fetch(`${runtime.mailUrl}/api/v1/message/${found.ID}`)).json());
      const url = message.Text.match(/https?:\/\/\S+/u)?.[0];
      if (url !== undefined) return url;
    }
    await delay(100);
  }
  throw new Error('No verification message received by isolated SMTP');
}
try {
  for (let index = 0; index < 50; index += 1) {
    // Fixture setup isolation only, like e2e/helpers.ts. Never reset during measured load.
    await authDatabase.pool.query('DELETE FROM auth_rate_limits');
    const email = `readiness-${crypto.randomUUID()}@example.test`;
    const password = `Readiness-${crypto.randomUUID()}`;
    const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Synthetic readiness fixture',
        email,
        password,
        callbackURL: `${origin}/en/dashboard`,
      }),
    });
    requireStatus(signup, 200, 'signup');
    const verification = await fetch(await verificationUrl(email), { redirect: 'manual' });
    if (![200, 302].includes(verification.status)) throw new Error('Email verification failed');
    const signin = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    requireStatus(signin, 200, 'signin');
    const cookie = signin.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const headers = { origin, cookie, 'content-type': 'application/json' };
    const listed = await fetch(`${origin}/api/projects`, { headers });
    requireStatus(listed, 200, 'project listing');
    const workspaceId = z
      .object({ workspaces: z.array(z.object({ id: z.uuid() })).min(1) })
      .parse(await listed.json()).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error('No provisioned workspace');
    const created = await fetch(`${origin}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspaceId,
        title: `Synthetic fixture ${index}`,
        language: index % 2 === 0 ? 'ar' : 'en',
      }),
    });
    requireStatus(created, 201, 'project creation');
    const projectId = z.object({ project: z.object({ id: z.uuid() }) }).parse(await created.json())
      .project.id;
    const marker = `readinessfixture${index}`;
    const body = new FormData();
    body.set(
      'file',
      new File(
        [
          `${marker}. Synthetic scientific evidence for software testing only. هذه بيانات اختبار اصطناعية وليست مصدراً علمياً.`,
        ],
        `fixture-${index}.txt`,
        { type: 'text/plain' },
      ),
    );
    const upload = await fetch(
      `${origin}/api/projects/${projectId}/sources?workspaceId=${workspaceId}`,
      { method: 'POST', headers: { origin, cookie }, body },
    );
    requireStatus(upload, 201, 'source upload');
    users.push({ cookie, workspaceId, projectId, marker });
  }
  // Fail if real extraction/ingestion did not make every user's own text retrievable.
  for (const user of users) {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = await fetch(`${origin}/api/sanad/retrieve`, {
        method: 'POST',
        headers: { origin, cookie: user.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: user.workspaceId,
          projectId: user.projectId,
          query: 'scientific',
        }),
      });
      requireStatus(result, 200, 'fixture evidence retrieval');
      const data = z
        .object({ mode: z.literal('lexical'), results: z.array(z.object({ content: z.string() })) })
        .parse(await result.json());
      if (data.results.some((entry) => entry.content.includes(user.marker))) {
        ready = true;
        break;
      }
      await delay(250);
    }
    if (!ready) throw new Error('Actual document extraction/ingestion did not complete');
  }
  await writeFile(outputPath, JSON.stringify({ baseUrl: origin, users }), { mode: 0o600 });
  process.stdout.write(
    'Prepared 50 isolated verified users with actual uploaded and ingested synthetic documents.\n',
  );
} finally {
  await authDatabase.close();
}
