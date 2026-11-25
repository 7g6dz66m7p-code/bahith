import { expect, test } from '@playwright/test';

import { registerAndVerify, resetRateLimits } from './helpers';
import { readCapturedCode } from './sms';

test.beforeEach(async () => {
  await resetRateLimits();
});

test('a signed-in researcher verifies a phone number by SMS code', async ({ page }, info) => {
  const locale = info.project.name.startsWith('ar') ? 'ar' : 'en';
  await registerAndVerify(page, locale, 'Phone fixture');
  // A distinct number per locale project: numbers are unique across accounts.
  const phone =
    locale === 'ar'
      ? `+96477${Date.now() % 100000000}`.slice(0, 14)
      : `+44770${Date.now() % 10000000}`;
  await page.goto(`/${locale}/verify-phone`);
  await expect(page.getByTestId('phone-status')).toBeVisible();
  const numberField = page.locator('input[name="phone"]');
  await numberField.fill('0770 123');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByTestId('phone-error')).toBeVisible();
  await numberField.fill(phone);
  await page.locator('form button[type="submit"]').click();
  const codeField = page.locator('input[name="code"]');
  await expect(codeField).toBeVisible();
  await codeField.fill('000000');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByTestId('phone-error')).toBeVisible();
  await codeField.fill(await readCapturedCode(phone));
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByTestId('phone-status')).toContainText(phone);
  // The same number appears on the security page after a reload.
  await page.goto(`/${locale}/security`);
  await expect(page.getByTestId('phone-status')).toContainText(phone);
});
