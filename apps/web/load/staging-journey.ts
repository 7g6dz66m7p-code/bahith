/**
 * Researcher journey against a running stack (staging): continues from prepare.ts
 * (sign-up, e-mail verification, sign-in, project, upload, real processing) with
 * search, quotation verification, a document and DOCX/PDF export. Prints a pass/fail
 * line per step; exits non-zero on the first failure. Local stacks only.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const env = JSON.parse(await readFile(process.argv[2] ?? '', 'utf8')) as {
  BASE: string;
  COOKIE: string;
  WORKSPACE_ID: string;
  PROJECT_ID: string;
};
// Local stacks, or a staging host (never the production domain): it creates test accounts.
if (!/^(http:\/\/(localhost|127\.0\.0\.1):\d+|https:\/\/staging\.[a-z0-9.-]+)$/u.test(env.BASE)) {
  throw new Error('local or staging stacks only');
}
const headers = { origin: env.BASE, cookie: env.COOKIE, 'content-type': 'application/json' };
const q = `workspaceId=${env.WORKSPACE_ID}`;
const step = (name: string, ok: boolean, detail = '') => {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
  if (!ok) process.exit(1);
};

const search = await fetch(`${env.BASE}/api/sanad/retrieve`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    workspaceId: env.WORKSPACE_ID,
    projectId: env.PROJECT_ID,
    query: 'التعلم المدمج',
  }),
});
const found = (await search.json()) as {
  results: { chunkId: string; content: string; pageStart: number | null }[];
};
const top = found.results[0];
step(
  'search',
  search.ok && top !== undefined,
  `${String(found.results.length)} passages, page ${String(top?.pageStart)}`,
);

// Retrieval through the app: the stored object (R2 on staging) streams back to the member
// byte-for-byte, and another workspace id is refused.
{
  const library = (await (
    await fetch(`${env.BASE}/api/projects/${env.PROJECT_ID}/sources?${q}`, { headers })
  ).json()) as { sources: { files: { id: string; originalName: string }[] }[] };
  const file = library.sources
    .flatMap((source) => source.files)
    .find((f) => f.originalName === 'ar-elearning.pdf');
  const original = await readFile(
    new URL('../../../eval/sanad/corpus/ar-elearning.pdf', import.meta.url),
  );
  const fetched = await fetch(
    `${env.BASE}/api/projects/${env.PROJECT_ID}/files/${file?.id ?? ''}?${q}`,
    { headers: { origin: env.BASE, cookie: env.COOKIE } },
  );
  const bytes = Buffer.from(await fetched.arrayBuffer());
  const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  step(
    'retrieve stored document',
    fetched.ok && digest(bytes) === digest(original),
    `HTTP ${String(fetched.status)}, ${String(bytes.length)} bytes, SHA-256 ${digest(bytes) === digest(original) ? 'matches' : 'DIFFERS'}`,
  );
  const foreign = await fetch(
    `${env.BASE}/api/projects/${env.PROJECT_ID}/files/${file?.id ?? ''}?workspaceId=${crypto.randomUUID()}`,
    { headers: { origin: env.BASE, cookie: env.COOKIE } },
  );
  step(
    'stored document refused to another workspace',
    !foreign.ok,
    `HTTP ${String(foreign.status)}`,
  );
}

const liveAi = process.env.STAGING_EXPECT_AI === '1';
await fetch(`${env.BASE}/api/projects/${env.PROJECT_ID}/ai-consent?${q}`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({ enabled: true }),
});
if (liveAi) {
  // Real model calls (no mocks): grounded answers with page-cited evidence, in both
  // languages, and a claim checked against the stored passages.
  const pdf = await readFile(new URL('../../../eval/sanad/corpus/en-sleep.pdf', import.meta.url));
  const form = new FormData();
  form.set('file', new File([pdf], 'en-sleep.pdf', { type: 'application/pdf' }));
  const upload = await fetch(`${env.BASE}/api/projects/${env.PROJECT_ID}/sources?${q}`, {
    method: 'POST',
    headers: { origin: env.BASE, cookie: env.COOKIE },
    body: form,
  });
  step('upload English source', upload.ok);
  let ready = false;
  for (let i = 0; i < 180 && !ready; i += 1) {
    const library = (await (
      await fetch(`${env.BASE}/api/projects/${env.PROJECT_ID}/sources?${q}`, { headers })
    ).json()) as { sources: { files: { status: string }[] }[] };
    ready = library.sources.every((source) => source.files.every((f) => f.status === 'ready'));
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  step('both sources processed', ready);
  for (const [language, question] of [
    ['ar', 'ما مدة التجربة في دراسة التعلم المدمج؟'],
    ['en', 'How much more did participants with adequate sleep recall?'],
  ] as const) {
    const asked = await fetch(`${env.BASE}/api/projects/${env.PROJECT_ID}/assistant?${q}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ question, language }),
    });
    const reply = (await asked.json()) as {
      status?: string;
      model?: string;
      code?: string;
      sentences?: { support: string; evidence: { pageStart: number | null }[] }[];
    };
    const cited = (reply.sentences ?? []).filter(
      (s) => s.support === 'supported' && s.evidence.some((e) => e.pageStart !== null),
    );
    step(
      `assistant (${language}) answers with page-cited evidence`,
      asked.ok && reply.status === 'answered' && cited.length > 0,
      `HTTP ${String(asked.status)} ${String(reply.status ?? reply.code)} via ${String(reply.model)}; ${String(cited.length)} cited sentence(s)`,
    );
  }
  const unknown = await fetch(`${env.BASE}/api/projects/${env.PROJECT_ID}/assistant?${q}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ question: 'ما عاصمة كوكب نبتون؟', language: 'ar' }),
  });
  const abstained = (await unknown.json()) as { status?: string };
  step('assistant abstains without evidence', abstained.status === 'abstained');
  const claim = await fetch(`${env.BASE}/api/projects/${env.PROJECT_ID}/claims/verify?${q}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ claim: 'استمرت التجربة ستة عشر أسبوعاً.' }),
  });
  const verdict = (await claim.json()) as Record<string, unknown>;
  step(
    'claim verification against stored passages',
    claim.ok,
    `HTTP ${String(claim.status)} ${JSON.stringify(verdict).slice(0, 120)}`,
  );
} else {
  // Without AI keys the honest answer is 503 "not configured"; never a fabricated verdict.
  const verify = await fetch(`${env.BASE}/api/projects/${env.PROJECT_ID}/claims/verify?${q}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ claim: (top?.content ?? '').slice(0, 120) }),
  });
  const verdict = (await verify.json()) as { code?: string };
  step(
    'claim verification without AI keys is refused clearly',
    verify.status === 503 && verdict.code === 'AI_NOT_CONFIGURED',
    `HTTP ${String(verify.status)} ${String(verdict.code)}`,
  );
}

const created = await fetch(`${env.BASE}/api/projects/${env.PROJECT_ID}/documents?${q}`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ title: 'مسودة اختبار Staging' }),
});
const { document } = (await created.json()) as { document?: { id: string } };
step('create document', created.ok && document !== undefined);
for (const format of ['docx', 'pdf']) {
  const exported = await fetch(
    `${env.BASE}/api/projects/${env.PROJECT_ID}/documents/${document?.id ?? ''}/export?${q}&format=${format}`,
    { headers },
  );
  const bytes = new Uint8Array(await exported.arrayBuffer());
  const magic = format === 'pdf' ? '%PDF' : 'PK';
  step(
    `export ${format}`,
    exported.ok && new TextDecoder().decode(bytes.slice(0, magic.length)) === magic,
    `${String(bytes.length)} bytes`,
  );
}
