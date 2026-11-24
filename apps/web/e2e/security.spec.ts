import { expect, test } from '@playwright/test';

test('production pages carry a fresh nonce matching their executable scripts', async ({
  page,
}, info) => {
  const path = `/${info.project.name}`;
  const first = await page.goto(path);
  const policy = first?.headers()['content-security-policy'];
  expect(policy).toBeDefined();
  expect(policy).not.toContain('unsafe-eval');
  const nonce = policy?.match(/'nonce-([^']+)'/u)?.[1];
  expect(nonce).toBeTruthy();
  const scripts = await page
    .locator('script')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLScriptElement).nonce));
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.every((value) => value === nonce)).toBe(true);
  expect(first?.headers()['x-content-type-options']).toBe('nosniff');
  expect(first?.headers()['x-frame-options']).toBe('DENY');
  const second = await page.goto(path);
  expect(second?.headers()['content-security-policy']).not.toBe(policy);
});

test('the browser blocks an injected script while the application still hydrates', async ({
  page,
}, info) => {
  const path = `/${info.project.name}`;
  await page.route(`**${path}`, async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({
      response,
      body: html.replace('</head>', '<script>window.bahithInjected = true</script></head>'),
    });
  });
  await page.goto(path);
  expect(await page.evaluate(() => 'bahithInjected' in window)).toBe(false);
  // A blocked injection must not be confused with broken framework hydration.
  const button = page.getByRole('button', { name: /المظهر|theme/iu });
  await expect(button).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /system|light|dark/u);
  const initial = await page.locator('html').getAttribute('data-theme');
  await button.click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', initial ?? '');
});

test('unauthenticated private API responses cannot be stored by shared caches', async ({
  request,
}) => {
  const response = await request.get('/api/projects');
  expect(response.status()).toBe(401);
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['content-security-policy']).toContain("default-src 'none'");
});
