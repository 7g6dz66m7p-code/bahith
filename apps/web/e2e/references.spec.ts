import { parseBibtex } from '@bahith/citations';
import { expect, test } from '@playwright/test';
import { z } from 'zod';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { registerAndVerify, resetRateLimits } from './helpers';

const ORIGIN = { origin: 'http://localhost:3100' };

/** Synthetic bibliography (test data, not claimed to be real publications). */
const BIBTEX = String.raw`@article{arabic2024,
  title = {أثر التعلم الإلكتروني في التحصيل الدراسي},
  author = {الأحمد, سارة and Khalil, Omar},
  journal = {مجلة الدراسات التربوية},
  year = {2024},
  volume = {12},
  pages = {45--67}
}
@book{english2019,
  title = {Methods of Qualitative Inquiry},
  author = {Smith, Jane},
  publisher = {Example Press},
  year = {2019}
}
@misc{untitled,
  author = {Nobody, Anne},
  year = {2020}
}
`;

test.beforeEach(async () => {
  await resetRateLimits();
});

test('BibTeX is imported as unverified references, deduplicated and exported', async ({
  page,
}, info) => {
  const locale = info.project.name.startsWith('ar') ? 'ar' : 'en';
  const m = (locale === 'ar' ? ar : en).References;
  await registerAndVerify(page, locale, 'References fixture');
  const { workspaces } = z
    .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
    .parse(await (await page.request.get('/api/projects')).json());
  const workspaceId = workspaces[0]?.id ?? '';
  const created = await page.request.post('/api/projects', {
    headers: ORIGIN,
    data: { workspaceId, title: 'مشروع المراجع', language: locale },
  });
  const { project } = z.object({ project: z.object({ id: z.uuid() }) }).parse(await created.json());
  await page.goto(`/${locale}/workspaces/${workspaceId}/projects/${project.id}`);

  const panel = page.locator('section[aria-labelledby="references-title"]');
  await expect(panel.getByText(m.empty)).toBeVisible();

  const file = { name: 'refs.bib', mimeType: 'application/x-bibtex', buffer: Buffer.from(BIBTEX) };
  await panel.getByLabel(m.importLabel).setInputFiles(file);
  await panel.getByRole('button', { name: m.import, exact: true }).click();
  await expect(panel.getByRole('status')).toContainText(
    locale === 'ar' ? 'مرجعان' : '2 references',
  );

  const items = panel.getByRole('list', { name: m.title }).getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.filter({ hasText: 'أثر التعلم الإلكتروني' })).toContainText(
    m.statusUnverified,
  );
  await expect(items.filter({ hasText: 'Methods of Qualitative Inquiry' })).toHaveAttribute(
    'data-verification',
    'unverified',
  );

  // The same file again adds nothing.
  await panel.getByLabel(m.importLabel).setInputFiles(file);
  await panel.getByRole('button', { name: m.import, exact: true }).click();
  await expect(panel.getByRole('status')).toBeVisible();
  await expect(items).toHaveCount(2);

  // Export round-trips the stored metadata, Arabic intact.
  const query = `workspaceId=${workspaceId}`;
  const bib = await page.request.get(
    `/api/projects/${project.id}/references/export?${query}&format=bibtex`,
  );
  expect(bib.status()).toBe(200);
  // Parse it back: BibTeX protects capitals with braces, so compare parsed titles.
  const titles = parseBibtex(await bib.text()).map((item) => item.title);
  expect(titles.sort()).toEqual(
    ['Methods of Qualitative Inquiry', 'أثر التعلم الإلكتروني في التحصيل الدراسي'].sort(),
  );
  const ris = await page.request.get(
    `/api/projects/${project.id}/references/export?${query}&format=ris`,
  );
  const risText = await ris.text();
  expect(risText).toMatch(/^TY {2}- /mu);
  expect(risText).toContain('مجلة الدراسات التربوية');

  // Without registry configuration, verifying says so and changes nothing.
  await items
    .filter({ hasText: 'Methods of Qualitative Inquiry' })
    .getByRole('button', { name: new RegExp(m.verify) })
    .click();
  await expect(panel.getByRole('alert')).toHaveText(m.errorNotConfigured);
  await expect(items.filter({ hasText: 'Methods of Qualitative Inquiry' })).toHaveAttribute(
    'data-verification',
    'unverified',
  );

  // Another user cannot list, import into or export this project's references.
  const outsider = await page.context().browser()?.newContext({ baseURL: 'http://localhost:3100' });
  if (outsider === undefined) throw new Error('no browser');
  const other = await outsider.newPage();
  await registerAndVerify(other, locale, 'References outsider');
  for (const url of [
    `/api/projects/${project.id}/references?${query}`,
    `/api/projects/${project.id}/references/export?${query}&format=bibtex`,
  ]) {
    expect([403, 404]).toContain((await other.request.get(url)).status());
  }
  await outsider.close();
});
