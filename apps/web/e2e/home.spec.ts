import { expect, test } from '@playwright/test';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

const expected = {
  ar: { messages: ar, dir: 'rtl' },
  en: { messages: en, dir: 'ltr' },
} as const;

function projectLocale(name: string): keyof typeof expected {
  if (name !== 'ar' && name !== 'en') {
    throw new Error(`unexpected Playwright project: ${name}`);
  }
  return name;
}

test('the home page opens in the browser language with the right direction', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo.project.name);
  const { messages, dir } = expected[locale];

  await page.goto('/');

  await expect(page).toHaveURL(new RegExp(`/${locale}$`));
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.locator('html')).toHaveAttribute('dir', dir);
  await expect(page).toHaveTitle(messages.Metadata.title);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.Home.name);
  await expect(page.getByText(messages.Home.principle)).toBeVisible();
});

test('the language switcher changes language and direction', async ({ page }, testInfo) => {
  const from = projectLocale(testInfo.project.name);
  const to = from === 'ar' ? 'en' : 'ar';

  await page.goto(`/${from}`);
  await page
    .getByRole('navigation', { name: expected[from].messages.LocaleSwitcher.label })
    .getByRole('link', { name: expected[from].messages.LocaleSwitcher[to] })
    .click();

  await expect(page).toHaveURL(new RegExp(`/${to}$`));
  await expect(page.locator('html')).toHaveAttribute('dir', expected[to].dir);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(expected[to].messages.Home.name);
});

test('an unknown page shows the localized not-found page with status 404', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo.project.name);

  const response = await page.goto(`/${locale}/does-not-exist`);

  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    expected[locale].messages.NotFound.title,
  );
  await expect(page.locator('html')).toHaveAttribute('dir', expected[locale].dir);
});
