import { listInvitations, listMembers, MemberError } from '@bahith/db';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { locale as rootLocale } from 'next/root-params';
import { z } from 'zod';

import { MembersPanel } from '@/components/members-panel';
import { routing } from '@/i18n/routing';
import { getDatabase } from '@/server/db';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function MembersPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const locale = await rootLocale();
  if (!hasLocale(routing.locales, locale)) notFound();
  const session = await requireSession(locale);
  const workspaceId = z.uuid().safeParse((await params).workspaceId);
  if (!workspaceId.success) notFound();
  const actor = { userId: session.user.id, workspaceId: workspaceId.data };
  const database = getDatabase();
  const members = await listMembers(database, actor).catch((error: unknown) => {
    if (error instanceof MemberError) return null;
    throw error;
  });
  if (members === null) notFound();
  const owner = members.some((member) => member.isYou && member.role === 'owner');
  const invitations = owner ? await listInvitations(database, actor) : [];
  const t = await getTranslations('Members');
  return (
    <main className="app-shell mx-auto min-h-dvh w-full max-w-4xl space-y-6 px-5 py-7 sm:px-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">{t('title')}</h1>
        <p className="muted leading-relaxed">{t('description')}</p>
      </header>
      <MembersPanel
        workspaceId={workspaceId.data}
        locale={locale}
        members={members}
        invitations={invitations.map((invitation) => ({
          ...invitation,
          expiresAt: invitation.expiresAt.toISOString(),
        }))}
      />
    </main>
  );
}
