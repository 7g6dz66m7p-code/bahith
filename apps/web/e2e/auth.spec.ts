import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { readVerificationUrl, registerAndVerify, resetRateLimits, totpCode } from './helpers';

const catalogs = { ar, en };

test.beforeEach(async () => {
  await resetRateLimits();
});

function localeFor(project: string): keyof typeof catalogs {
  if (project !== 'ar' && project !== 'en') throw new Error('Unknown browser-test locale');
  return project;
}

async function signIn(page: Page, locale: 'ar' | 'en', email: string, password: string) {
  const messages = catalogs[locale];
  await page.goto(`/${locale}/sign-in`);
  await page.getByLabel(messages.Auth.email, { exact: true }).fill(email);
  await page.getByLabel(messages.Auth.password, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.Auth.signIn, exact: true }).click();
}

test('UI registration, verified login, project creation, command navigation and logout', async ({
  page,
}, testInfo) => {
  const locale = localeFor(testInfo.project.name);
  const messages = catalogs[locale];
  // These are ephemeral software-test identities, never real researcher accounts.
  const identity = {
    email: `ui-${crypto.randomUUID()}@example.test`,
    password: `BrowserFixture-${crypto.randomUUID()}`,
    name: locale === 'ar' ? 'باحث اختبار الواجهة' : 'UI test researcher',
  };

  await page.goto(`/${locale}/dashboard`);
  await expect(page).toHaveURL(new RegExp(`/${locale}/sign-in$`));
  await page.goto(`/${locale}/sign-up`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.Auth.signUpTitle);
  await page.getByLabel(messages.Auth.name, { exact: true }).fill(identity.name);
  await page.getByLabel(messages.Auth.email, { exact: true }).fill(identity.email);
  await page.getByLabel(messages.Auth.password, { exact: true }).fill(identity.password);
  await page.getByLabel(messages.Auth.confirmPassword, { exact: true }).fill(identity.password);
  await page.getByRole('button', { name: messages.Auth.signUp, exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(messages.Auth.signUpSuccess);

  await page.goto(await readVerificationUrl(identity.email));
  await page.context().clearCookies();
  await signIn(page, locale, identity.email, identity.password);
  await expect(page).toHaveURL(new RegExp(`/${locale}/dashboard$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    messages.Dashboard.welcome.replace('{name}', identity.name),
  );
  await expect(page.getByText(messages.Dashboard.roleOwner, { exact: true })).toBeVisible();
  await expect(page.getByText(messages.Dashboard.emptyProjects, { exact: true })).toBeVisible();

  const projectTitle =
    locale === 'ar' ? 'مشروع اختبار المسار البرمجي' : 'Browser workflow test project';
  const question =
    locale === 'ar'
      ? 'كيف نتحقق من عمل مسار إنشاء مشروع الاختبار؟'
      : 'How do we verify the project-creation software workflow?';
  await page.getByRole('button', { name: messages.Dashboard.newProject, exact: true }).click();
  await page.getByLabel(messages.Dashboard.projectTitle, { exact: true }).fill(projectTitle);
  await page.getByLabel(messages.Dashboard.researchQuestion, { exact: true }).fill(question);
  await page.getByLabel(messages.Dashboard.language, { exact: true }).selectOption(locale);
  await page.getByRole('button', { name: messages.Dashboard.createProject, exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(messages.Dashboard.projectCreated);
  await expect(
    page.getByRole('heading', { level: 3, name: projectTitle, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(question, { exact: true })).toBeVisible();

  const menuButton = page.getByRole('button', { name: messages.CommandMenu.open });
  await menuButton.focus();
  await page.keyboard.press('Control+k');
  const menu = page.getByRole('dialog', { name: messages.CommandMenu.title });
  await expect(menu).toBeVisible();
  await expect(menu.getByLabel(messages.CommandMenu.search, { exact: true })).toBeFocused();
  await menu
    .getByLabel(messages.CommandMenu.search, { exact: true })
    .fill(messages.CommandMenu.security);
  await expect(
    menu.getByRole('link', { name: messages.CommandMenu.security, exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole('link', { name: messages.CommandMenu.dashboard, exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(menuButton).toBeFocused();

  await page.getByRole('button', { name: messages.Dashboard.signOut, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/sign-in$`));
  await page.goto(`/${locale}/dashboard`);
  await expect(page).toHaveURL(new RegExp(`/${locale}/sign-in$`));
});

test('authenticator setup, sign-in challenge and disabling two-factor authentication', async ({
  page,
}, testInfo) => {
  const locale = localeFor(testInfo.project.name);
  const messages = catalogs[locale];
  const identity = await registerAndVerify(
    page,
    locale,
    locale === 'ar' ? 'باحث اختبار التحقق الثنائي' : 'Two-factor UI test researcher',
  );

  await page.getByRole('link', { name: messages.Dashboard.security, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/security$`));
  await page.getByLabel(messages.Security.password, { exact: true }).fill(identity.password);
  await page.getByRole('button', { name: messages.Security.enable, exact: true }).click();
  await expect(
    page.getByRole('heading', { name: messages.Security.pendingEnrollment }),
  ).toBeVisible();
  const key = page.getByLabel(messages.Security.setupKey, { exact: true });
  const secret = await key.inputValue();
  expect(secret.length > 0).toBe(true);
  await expect(
    page.getByRole('img', { name: messages.Security.setupUri, exact: true }),
  ).toBeVisible();
  const backupCodes = page
    .getByRole('region', { name: messages.Security.backupCodes })
    .locator('code');
  expect(await backupCodes.count()).toBeGreaterThan(0);
  await page.getByLabel(messages.Security.code, { exact: true }).fill(totpCode(secret));
  await page.getByLabel(messages.Security.confirmCodesSaved, { exact: true }).check();
  await page.getByRole('button', { name: messages.Security.confirmEnable, exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(messages.Security.enabledSuccess);
  await expect(page.getByText(messages.Security.enabled, { exact: true })).toBeVisible();
  await expect(page.getByLabel(messages.Security.setupKey, { exact: true })).toHaveCount(0);

  await page.getByRole('link', { name: messages.Security.backDashboard, exact: true }).click();
  await page.getByRole('button', { name: messages.Dashboard.signOut, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/sign-in$`));
  await signIn(page, locale, identity.email, identity.password);
  await expect(page).toHaveURL(new RegExp(`/${locale}/two-factor$`));
  await page.getByLabel(messages.Auth.totpCode, { exact: true }).fill(totpCode(secret));
  await page.getByRole('button', { name: messages.Auth.verifyCode, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/dashboard$`));

  await page.getByRole('link', { name: messages.Dashboard.security, exact: true }).click();
  await page.getByLabel(messages.Security.password, { exact: true }).fill(identity.password);
  await page.getByRole('button', { name: messages.Security.disable, exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(messages.Security.disabledSuccess);
  await expect(page.getByText(messages.Security.disabled, { exact: true })).toBeVisible();
});
