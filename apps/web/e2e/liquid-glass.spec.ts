import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { registerAndVerify, resetRateLimits } from './helpers';

/**
 * The Liquid Glass dashboard against the real stack: every figure comes from the user's
 * records (none before, the right counts after real actions), the hero search returns a
 * stored passage with its page, unavailable features say so, it stays accessible in both
 * themes at phone, tablet and desktop widths, and the phone menu is a working dialog.
 * Screenshots of each state are attached to the report.
 */
const catalogs = { ar, en };
const SOURCE_PDF = path.join(import.meta.dirname, '../../../eval/sanad/corpus/ar-elearning.pdf');

test.beforeEach(async () => {
  await resetRateLimits();
});

async function accessible(page: Page) {
  const report = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    report.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map(
        (violation) =>
          `${violation.id}: ${violation.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      ),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

async function setTheme(page: Page, label: string, target: string) {
  const appearance = page.getByRole('button', { name: new RegExp(`^${label}:`) });
  for (let i = 0; i < 3 && (await appearance.textContent()) !== target; i += 1) {
    await appearance.click();
  }
  await expect(appearance).toHaveText(target);
}

test('the glass dashboard shows only real data and real actions', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const locale = testInfo.project.name === 'en' ? 'en' : 'ar';
  const m = catalogs[locale];
  const g = m.Glass;
  await registerAndVerify(page, locale, locale === 'ar' ? 'أبو المهيب' : 'Glass researcher');
  await page.setViewportSize({ width: 1440, height: 1000 });

  // A new account: zero everywhere, shortcuts that need a project say so.
  await page.goto(`/${locale}/dashboard`);
  const stats = page.locator('section[aria-labelledby="stats-title"]');
  await expect(stats.getByRole('definition')).toHaveText(['0', '0', '0', '0']);
  await expect(page.getByText(g.workflow.empty)).toBeVisible();
  const tools = page.getByRole('navigation', { name: g.tools.title });
  await expect(tools.getByText(g.tools.unavailable)).toBeVisible();
  await expect(tools.getByText(g.tools.needsProject)).toHaveCount(5);
  await shot(page, testInfo, `dashboard-${locale}-empty-1440`);

  // Real work: a project with a question, a processed source and a draft.
  await page.getByRole('button', { name: m.Dashboard.newProject, exact: true }).click();
  await page
    .getByLabel(m.Dashboard.projectTitle, { exact: true })
    .fill('التعلم المدمج في الجامعات');
  await page
    .getByLabel(m.Dashboard.researchQuestion, { exact: true })
    .fill('ما أثر التعلم المدمج في تحصيل الطلبة؟');
  await page.getByRole('button', { name: m.Dashboard.createProject, exact: true }).click();
  await page.getByRole('link', { name: m.Dashboard.openProject }).first().click();
  await page.getByLabel(m.Project.uploadLabel).setInputFiles(SOURCE_PDF);
  await page.getByRole('button', { name: m.Project.upload }).click();
  await expect(page.getByTestId('file-status')).toHaveText(m.Project.statusReady, {
    timeout: 150_000,
  });
  await page.getByPlaceholder(m.Project.draftTitle).fill('الفصل الأول');
  await page.getByRole('button', { name: m.Project.createDraft }).click();
  await expect(page.getByRole('textbox', { name: m.Draft.editorLabel })).toBeVisible();

  // Back on the dashboard: the counts and the workflow follow those records.
  await page.goto(`/${locale}/dashboard`);
  await expect(stats.getByRole('definition')).toHaveText(['1', '1', '1', '0']);
  await expect(
    page.getByRole('img', { name: g.workflow.ring.replace('{percent}', '100') }),
  ).toBeVisible();
  await expect(tools.getByText(g.tools.needsProject)).toHaveCount(0);

  // The hero search returns a stored passage with its page number.
  await page.getByLabel(g.search.label).fill('التعلم المدمج');
  await page.getByRole('button', { name: g.search.submit }).click();
  const results = page.getByRole('heading', {
    name: g.search.resultsTitle.replace('{project}', 'التعلم المدمج في الجامعات'),
  });
  await expect(results).toBeVisible();
  await expect(page.getByText(g.search.page.replace('{page}', '1')).first()).toBeVisible();

  // Accessible and screenshotted at three widths, light and dark.
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    for (const [theme, label] of [
      ['light', m.Theme.light],
      ['dark', m.Theme.dark],
    ] as const) {
      await setTheme(page, m.Theme.label, label);
      await accessible(page);
      await shot(page, testInfo, `dashboard-${locale}-${String(width)}-${theme}`);
    }
  }

  // Phones: the sidebar is a menu button opening a modal navigation.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: g.nav.openMenu, exact: true }).click();
  const menu = page.getByRole('dialog', { name: g.nav.label });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('link', { name: g.nav.dashboard })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await shot(page, testInfo, `dashboard-${locale}-390-menu`);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await setTheme(page, m.Theme.label, m.Theme.system);
});
