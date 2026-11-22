import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { registerAndVerify, resetRateLimits } from './helpers';

const catalogs = { ar, en };

test.beforeEach(async () => {
  await resetRateLimits();
});

function localeFor(project: string): keyof typeof catalogs {
  if (project !== 'ar' && project !== 'en') throw new Error('Unknown browser-test locale');
  return project;
}

async function expectAccessible(page: Page) {
  const report = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    report.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    ),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test('responsive sign-in and dashboard are accessible in light and dark modes', async ({
  page,
}, testInfo) => {
  const locale = localeFor(testInfo.project.name);
  const messages = catalogs[locale];
  await registerAndVerify(
    page,
    locale,
    locale === 'ar' ? 'باحث اختبار الإتاحة' : 'Accessibility test researcher',
  );
  const authenticatedCookies = await page.context().cookies();
  for (const width of [360, 768, 1440]) {
    await test.step(`${width}px light and dark`, async () => {
      await page.setViewportSize({ width, height: 1000 });
      await page.context().addCookies(authenticatedCookies);
      await page.goto(`/${locale}/dashboard`);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      if (width === 360 || width === 1440) {
        await page.screenshot({
          path: testInfo.outputPath(`dashboard-${locale}-${width}-light.png`),
          fullPage: true,
        });
      }
      await expectAccessible(page);

      const appearance = page.getByRole('button', {
        name: new RegExp(`^${messages.Theme.label}:`),
      });
      await expect(appearance).toHaveText(messages.Theme.system);
      await appearance.click();
      await appearance.click();
      await expect(appearance).toHaveText(messages.Theme.dark);
      if (width === 360 || width === 1440) {
        await page.screenshot({
          path: testInfo.outputPath(`dashboard-${locale}-${width}-dark.png`),
          fullPage: true,
        });
      }
      await expectAccessible(page);

      await page.context().clearCookies();
      await page.goto(`/${locale}/sign-in`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.Auth.signInTitle);
      await expectAccessible(page);
      await appearance.click();
      await expect(appearance).toHaveText(messages.Theme.system);
      await expectAccessible(page);
    });
  }
});

test('the project page with library, assistant and references panels is accessible', async ({
  page,
}, testInfo) => {
  const locale = localeFor(testInfo.project.name);
  const messages = catalogs[locale];
  await registerAndVerify(page, locale, locale === 'ar' ? 'باحث إتاحة المشروع' : 'Project a11y');
  const { workspaces } = (await (await page.request.get('/api/projects')).json()) as {
    workspaces: { id: string }[];
  };
  const workspaceId = workspaces[0]?.id ?? '';
  const created = (await (
    await page.request.post('/api/projects', {
      headers: { origin: 'http://localhost:3100' },
      data: {
        workspaceId,
        title: locale === 'ar' ? 'مشروع الإتاحة' : 'Accessibility project',
        language: locale,
      },
    })
  ).json()) as { project: { id: string } };
  for (const width of [360, 1440]) {
    await test.step(`${width}px light and dark`, async () => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/${locale}/workspaces/${workspaceId}/projects/${created.project.id}`);
      await expect(page.getByRole('heading', { name: messages.Assistant.title })).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({
        path: testInfo.outputPath(`project-${locale}-${width}-light.png`),
        fullPage: true,
      });
      const appearance = page.getByRole('button', {
        name: new RegExp(`^${messages.Theme.label}:`),
      });
      while ((await appearance.textContent()) !== messages.Theme.dark) await appearance.click();
      await expectAccessible(page);
      while ((await appearance.textContent()) !== messages.Theme.system) await appearance.click();
    });
  }
});
