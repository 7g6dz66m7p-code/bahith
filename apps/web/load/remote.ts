/**
 * Shared by the load/journey scripts when they run against a remote test stack.
 *
 * - Which base URLs are allowed: local stacks, a staging host, or a bahith-preview branch
 *   deployment on Vercel. Never the production domain (the scripts create test accounts).
 * - Vercel Deployment Protection: when VERCEL_AUTOMATION_BYPASS_SECRET is set, its header
 *   is added to requests for the stack's own origin only (never to any other host).
 * - The verification e-mail: from the harness's Mailpit, or (preview) from Resend's API
 *   with RESEND_API_KEY, for a Resend test address. The key is sent to api.resend.com only.
 */

const ALLOWED =
  /^(http:\/\/(localhost|127\.0\.0\.1):\d+|https:\/\/staging\.[a-z0-9.-]+|https:\/\/bahith-preview-git-[a-z0-9-]+\.vercel\.app)$/u;

export function assertTestStack(base: string): void {
  if (!ALLOWED.test(base)) throw new Error('local, staging or preview stacks only');
}

export function installProtectionBypass(base: string): void {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '';
  if (secret === '') return;
  const origin = new URL(base).origin;
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (new URL(url).origin !== origin) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    headers.set('x-vercel-protection-bypass', secret);
    return original(input, { ...init, headers });
  };
}

/** A fresh recipient for a test account; Resend test addresses accept +labels. */
export function testRecipient(): string {
  const id = crypto.randomUUID();
  return process.env.LOAD_MAIL_PROVIDER === 'resend'
    ? `delivered+${id}@resend.dev`
    : `load-${id}@example.test`;
}

const LINK = /https?:\/\/[^\s"'<>]+/u;
const decode = (text: string) => text.replaceAll('&amp;', '&');

async function fromResend(to: string): Promise<string | undefined> {
  const key = process.env.RESEND_API_KEY ?? '';
  if (key === '') throw new Error('RESEND_API_KEY is not set');
  const headers = { authorization: `Bearer ${key}` };
  const list = await fetch('https://api.resend.com/emails?limit=50', { headers });
  if (!list.ok) throw new Error(`resend list ${String(list.status)}`);
  const { data } = (await list.json()) as { data: { id: string; to: string[] }[] };
  const sent = data.find((email) => email.to.includes(to));
  if (sent === undefined) return undefined;
  const one = await fetch(`https://api.resend.com/emails/${sent.id}`, { headers });
  if (!one.ok) throw new Error(`resend retrieve ${String(one.status)}`);
  const body = (await one.json()) as { text?: string | null; html?: string | null };
  const match = LINK.exec(body.text ?? '') ?? LINK.exec(body.html ?? '');
  return match === null ? undefined : decode(match[0]);
}

async function fromMailpit(mailUrl: string, to: string): Promise<string | undefined> {
  const list = (await (await fetch(`${mailUrl}/api/v1/messages`)).json()) as {
    messages: { ID: string; To: { Address: string }[] }[];
  };
  const message = list.messages.find((m) => m.To.some((r) => r.Address === to));
  if (message === undefined) return undefined;
  const body = (await (await fetch(`${mailUrl}/api/v1/message/${message.ID}`)).json()) as {
    Text: string;
  };
  return LINK.exec(body.Text)?.[0];
}

/** Polls for the verification link sent to `to` (about 60 s at most). */
export async function verificationLink(
  to: string,
  mailUrl: () => Promise<string>,
): Promise<string> {
  const resend = process.env.LOAD_MAIL_PROVIDER === 'resend';
  const mailpit = resend ? '' : await mailUrl();
  for (let i = 0; i < 60; i += 1) {
    const link = resend ? await fromResend(to) : await fromMailpit(mailpit, to);
    if (link !== undefined) return link;
    await new Promise((resolve) => setTimeout(resolve, resend ? 2000 : 500));
  }
  throw new Error('no verification email');
}
