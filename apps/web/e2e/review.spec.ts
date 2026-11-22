import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { z } from 'zod';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { addWorkspaceMember, registerAndVerify, resetRateLimits } from './helpers';

/**
 * Draft review journey: the owner writes a draft, a supervisor (added to the workspace)
 * reads it read-only, comments and suggests a change; the owner accepts the suggestion,
 * which becomes a new version; a suggestion whose text was edited away is refused with a
 * clear message. All text is synthetic test content.
 */
const ORIGIN = { origin: 'http://localhost:3100' };
const SENTENCE = 'تعتمد الدراسة على المنهج الوصفي في تحليل البيانات المجمعة من العينة';

const paragraphDoc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** The anchor of `quote` in a one-paragraph draft (its text starts at position 1). */
const anchorIn = (text: string, quote: string, versionNumber: number) => {
  const offset = text.indexOf(quote);
  return { versionNumber, from: 1 + offset, to: 1 + offset + quote.length, quote };
};

const documentSchema = z.object({
  version: z.number(),
  content: z.unknown(),
});

async function userIdOf(request: APIRequestContext): Promise<string> {
  return z
    .object({ user: z.object({ id: z.uuid() }) })
    .parse(await (await request.get('/api/auth/get-session')).json()).user.id;
}

/** Selects `phrase` in the editor the way a mouse selection would (DOM selection). */
async function selectInDraft(page: Page, phrase: string) {
  await page.evaluate((text) => {
    const root = document.querySelector('.draft-content');
    if (root === null) throw new Error('no editor');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const index = (node.textContent ?? '').indexOf(text);
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
    }
    throw new Error('phrase not found in the draft');
  }, phrase);
}

test.beforeEach(async () => {
  await resetRateLimits();
});

test('a supervisor comments and suggests; the owner accepts; stale suggestions are refused', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const locale = info.project.name === 'ar' ? 'ar' : 'en';
  const r = (locale === 'ar' ? ar : en).Draft.review;
  const d = (locale === 'ar' ? ar : en).Draft;

  // The owner's draft.
  await registerAndVerify(page, locale, 'Review owner');
  const { workspaces } = z
    .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
    .parse(await (await page.request.get('/api/projects')).json());
  const workspaceId = workspaces[0]?.id ?? '';
  const { project } = z.object({ project: z.object({ id: z.uuid() }) }).parse(
    await (
      await page.request.post('/api/projects', {
        headers: ORIGIN,
        data: { workspaceId, title: 'مشروع المراجعة', language: locale },
      })
    ).json(),
  );
  const q = `?workspaceId=${workspaceId}`;
  const base = `/api/projects/${project.id}/documents`;
  const { document } = z
    .object({ document: z.object({ id: z.uuid() }) })
    .parse(
      await (
        await page.request.post(`${base}${q}`, { headers: ORIGIN, data: { title: 'فصل المنهج' } })
      ).json(),
    );
  const docBase = `${base}/${document.id}`;
  expect(
    (
      await page.request.put(`${docBase}${q}`, {
        headers: ORIGIN,
        data: { content: paragraphDoc(SENTENCE), baseVersion: 1, kind: 'manual' },
      })
    ).status(),
  ).toBe(200);
  const draftUrl = `/${locale}/workspaces/${workspaceId}/projects/${project.id}/documents/${document.id}`;

  const supervisor = await browser.newContext({ baseURL: 'http://localhost:3100' });
  const outsider = await browser.newContext({ baseURL: 'http://localhost:3100' });
  try {
    const reviewer = await supervisor.newPage();
    await registerAndVerify(reviewer, locale, 'Review supervisor');
    await addWorkspaceMember(workspaceId, await userIdOf(supervisor.request), 'supervisor');

    // The supervisor reads the draft read-only, with the review panel.
    await reviewer.goto(draftUrl);
    const editor = reviewer.getByRole('textbox', { name: d.editorLabel });
    await expect(editor).toContainText(SENTENCE);
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(reviewer.getByText(d.reviewOnly)).toBeVisible();
    await expect(reviewer.getByRole('toolbar', { name: d.toolbar })).toHaveCount(0);

    // A comment on a selected phrase.
    await selectInDraft(reviewer, 'المنهج الوصفي');
    await reviewer.getByRole('button', { name: r.comment, exact: true }).click();
    await expect(reviewer.getByTestId('review-target')).toHaveText('المنهج الوصفي');
    await reviewer.getByLabel(r.commentLabel).fill('لماذا اخترت هذا المنهج؟');
    await reviewer.getByRole('button', { name: r.addComment }).click();
    await expect(reviewer.getByTestId('review-note')).toHaveCount(1);

    // A suggested change on another phrase.
    await selectInDraft(reviewer, 'تحليل البيانات');
    await reviewer.getByRole('button', { name: r.suggest, exact: true }).click();
    await reviewer.getByLabel(r.replacementLabel).fill('تحليل بيانات الاستبانة');
    await reviewer.getByRole('button', { name: r.addSuggestion }).click();
    await expect(reviewer.getByTestId('review-note')).toHaveCount(2);
    // Both anchors are marked in the text (decorations, not document content).
    await expect(editor.locator('[data-review-anchor]')).toHaveCount(2);
    await expect(reviewer.getByRole('button', { name: r.accept })).toHaveCount(0);
    // The review panel adds no serious accessibility violation.
    const report = await new AxeBuilder({ page: reviewer })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      report.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious',
      ),
    ).toEqual([]);

    // The supervisor cannot write content or decide on the suggestion.
    const notes = z
      .object({
        comments: z.array(z.object({ id: z.uuid(), kind: z.string(), authorRole: z.string() })),
      })
      .parse(await (await supervisor.request.get(`${docBase}/comments${q}`)).json()).comments;
    expect(notes.map((note) => [note.kind, note.authorRole])).toEqual([
      ['comment', 'supervisor'],
      ['suggestion', 'supervisor'],
    ]);
    const suggestionId = notes[1]?.id ?? '';
    expect(
      (
        await supervisor.request.put(`${docBase}${q}`, {
          headers: ORIGIN,
          data: { content: paragraphDoc('نص المشرف'), baseVersion: 2 },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await supervisor.request.patch(`${docBase}/comments/${suggestionId}${q}`, {
          headers: ORIGIN,
          data: { action: 'accept', baseVersion: 2 },
        })
      ).status(),
    ).toBe(403);

    // The supervisor resolves their own comment.
    await reviewer.getByRole('button', { name: r.resolve }).click();
    await expect(reviewer.locator('[data-testid="review-note"][data-status="open"]')).toHaveCount(
      1,
    );

    // Someone outside the workspace can neither read nor write review notes.
    await registerAndVerify(await outsider.newPage(), locale, 'Review outsider');
    expect((await outsider.request.get(`${docBase}/comments${q}`)).status()).toBe(403);
    expect(
      (
        await outsider.request.post(`${docBase}/comments${q}`, {
          headers: ORIGIN,
          data: {
            kind: 'comment',
            anchor: anchorIn(SENTENCE, 'الدراسة', 2),
            body: 'دخيل',
          },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await outsider.request.patch(`${docBase}/comments/${suggestionId}${q}`, {
          headers: ORIGIN,
          data: { action: 'reject' },
        })
      ).status(),
    ).toBe(403);
    // Cross-site form posts are refused even for members.
    expect(
      (
        await supervisor.request.post(`${docBase}/comments${q}`, {
          headers: { origin: 'https://attacker.example.test' },
          data: { kind: 'comment', anchor: anchorIn(SENTENCE, 'الدراسة', 2), body: 'x' },
        })
      ).status(),
    ).toBe(403);

    // The owner accepts the suggestion in the editor: a new version with the replacement.
    await page.goto(draftUrl);
    await expect(
      page.getByTestId('review-note').filter({ hasText: r.kind.suggestion }),
    ).toHaveCount(1);
    await page.getByRole('button', { name: r.accept }).click();
    await expect(page.getByTestId('review-notice')).toHaveText(
      r.accepted.replace('{version}', '3'),
    );
    const accepted = SENTENCE.replace('تحليل البيانات', 'تحليل بيانات الاستبانة');
    const ownerEditor = page.getByRole('textbox', { name: d.editorLabel });
    await expect(ownerEditor).toContainText(accepted);
    const latest = documentSchema.parse(await (await page.request.get(`${docBase}${q}`)).json());
    expect(latest.version).toBe(3);
    expect(latest.content).toEqual(paragraphDoc(accepted));
    await page.reload();
    await expect(ownerEditor).toContainText(accepted);
    await expect(page.getByTestId('save-state')).toHaveText(d.save.saved);

    // A suggestion whose text the owner then edits away is refused, with a clear message.
    const stale = await supervisor.request.post(`${docBase}/comments${q}`, {
      headers: ORIGIN,
      data: {
        kind: 'suggestion',
        anchor: anchorIn(accepted, 'من العينة', 3),
        replacement: 'من عينة الدراسة',
      },
    });
    expect(stale.status()).toBe(201);
    const staleId = z.object({ comment: z.object({ id: z.uuid() }) }).parse(await stale.json())
      .comment.id;
    const edited = accepted.replace('من العينة', 'من المشاركين');
    expect(
      (
        await page.request.put(`${docBase}${q}`, {
          headers: ORIGIN,
          data: { content: paragraphDoc(edited), baseVersion: 3, kind: 'manual' },
        })
      ).status(),
    ).toBe(200);
    expect(
      await (
        await page.request.patch(`${docBase}/comments/${staleId}${q}`, {
          headers: ORIGIN,
          data: { action: 'accept', baseVersion: 4 },
        })
      ).json(),
    ).toEqual({ code: 'REVIEW_ANCHOR_STALE' });
    await page.reload();
    await page.getByRole('button', { name: r.accept }).click();
    await expect(page.getByTestId('review-notice')).toHaveText(r.error.stale);
    await expect(ownerEditor).toContainText(edited);
    expect(documentSchema.parse(await (await page.request.get(`${docBase}${q}`)).json())).toEqual(
      expect.objectContaining({ version: 4 }),
    );
    // The owner can still decline it.
    await page.getByRole('button', { name: r.reject }).click();
    await expect(page.locator('[data-testid="review-note"][data-status="open"]')).toHaveCount(0);
  } finally {
    await supervisor.close();
    await outsider.close();
  }
});
