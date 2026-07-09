// E2E regression guard: the Worker tab's Worker Processes pane must scroll when
// it overflows. Before the flex-col wrapper fix the pane grew to content height
// (clientHeight === scrollHeight) and could not scroll.

import { test, expect } from './fixtures/electron-app.js';

test.describe('Worker tab scroll', () => {
  test('worker processes list scrolls when it overflows', async ({ page }) => {
    // Short window so the built-in workers overflow the pane.
    await page.setViewportSize({ width: 1100, height: 640 });

    await page.getByTestId('sidebar-workers').click();

    const section = page.getByTestId('worker-processes-section');
    await expect(section).toBeVisible();
    await expect(page.getByTestId('worker-row-autofix')).toBeVisible();

    const pane = section.locator('> div').first();

    const metrics = await pane.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    // Scroll in steps so the walkthrough video shows motion.
    const maxScroll = metrics.scrollHeight - metrics.clientHeight;
    for (let step = 1; step <= 6; step += 1) {
      await pane.evaluate((el, top) => {
        el.scrollTop = top;
      }, Math.round((maxScroll * step) / 6));
      await page.waitForTimeout(150);
    }

    expect(await pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
});
