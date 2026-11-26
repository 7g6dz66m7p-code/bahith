import { readFileSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/** Every story tagged "visual", in Arabic (RTL) and English, light and dark. */
const index = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '../storybook-static/index.json'), 'utf8'),
) as { entries: Record<string, { id: string; type: string; tags?: string[] }> };
const stories = Object.values(index.entries).filter(
  (entry) => entry.type === 'story' && (entry.tags ?? []).includes('visual'),
);

test('Storybook has visual stories', () => {
  expect(stories.length).toBeGreaterThan(5);
});

for (const story of stories) {
  for (const locale of ['ar', 'en'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${story.id} ${locale} ${theme}`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(
          `/iframe.html?id=${story.id}&viewMode=story&globals=locale:${locale};theme:${theme}`,
        );
        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.evaluate(() => document.fonts.ready);
        // Charts load on demand; wait until the panel has drawn.
        await page.waitForLoadState('networkidle');
        const report = await new AxeBuilder({ page })
          .include('#storybook-root')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          report.violations
            .filter((v) => v.impact === 'critical' || v.impact === 'serious')
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
        ).toEqual([]);
        await expect(page.locator('#storybook-root')).toHaveScreenshot(
          `${story.id}--${locale}-${theme}.png`,
        );
      });
    }
  }
}
