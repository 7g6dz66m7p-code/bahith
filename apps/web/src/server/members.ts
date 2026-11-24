import type { AuthMailTransport } from '@bahith/auth';
import { createAuthMailTransport, parseAuthConfig } from '@bahith/auth';
import { MemberError } from '@bahith/db';
import { z } from 'zod';

import { getRequestSession } from './session';

const holder = globalThis as typeof globalThis & { __bahithMail?: AuthMailTransport | null };

function mailTransport(): AuthMailTransport | null {
  if (holder.__bahithMail === undefined) {
    const smtp = parseAuthConfig(process.env).smtp;
    holder.__bahithMail = smtp === undefined ? null : createAuthMailTransport(smtp);
  }
  return holder.__bahithMail;
}

/**
 * The accept link carries the token in the URL fragment, which browsers never send to a
 * server: it cannot reach access logs or Referer headers.
 */
export function invitationLink(locale: 'ar' | 'en', token: string): string {
  const origin = new URL(process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').origin;
  return `${origin}/${locale}/invitations/accept#${token}`;
}

/** Sends the invitation when SMTP is configured; returns whether it was handed to SMTP. */
export async function sendInvitationEmail(to: string, link: string): Promise<boolean> {
  const transport = mailTransport();
  if (transport === null) return false;
  try {
    await transport.send({
      to,
      subject: 'باحث | BAHITH — دعوة إلى فضاء عمل / Workspace invitation',
      text: [
        'دُعيت للانضمام إلى فضاء عمل بحثي على منصة باحث.',
        'سجّل الدخول بهذا البريد نفسه ثم افتح الرابط (صالح 7 أيام):',
        link,
        '',
        'You have been invited to a research workspace on BAHITH.',
        'Sign in with this same email address, then open the link (valid for 7 days):',
        link,
      ].join('\n'),
    });
    return true;
  } catch {
    return false;
  }
}

export async function workspaceActor(request: Request, params: Promise<{ workspaceId: string }>) {
  const session = await getRequestSession(request);
  if (session === null) return null;
  const workspaceId = z.uuid().safeParse((await params).workspaceId);
  if (!workspaceId.success) throw new MemberError('MEMBER_INVALID_INPUT');
  return { userId: session.user.id, workspaceId: workspaceId.data };
}

const STATUS: Record<string, number> = {
  MEMBER_FORBIDDEN: 403,
  MEMBER_INVALID_INPUT: 400,
  MEMBER_NOT_FOUND: 404,
  MEMBER_LAST_OWNER: 409,
  INVITATION_INVALID: 404,
  INVITATION_EXPIRED: 410,
  INVITATION_EMAIL_MISMATCH: 403,
};

export function memberErrorResponse(error: MemberError): Response {
  return Response.json({ code: error.code }, { status: STATUS[error.code] ?? 400 });
}
