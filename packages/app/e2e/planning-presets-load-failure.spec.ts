import { test, expect, captureScreenshot } from './fixtures/electron-app.js';

test.describe('planning presets load failure', () => {
  test.use({ breakPlanningPresets: true });

  test('logs the real console.error instead of silently falling back to Codex, and captures it as visual proof', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });

    await expect
      .poll(() => consoleErrors.some((line) => line.includes('Failed to load planning presets')), { timeout: 10000 })
      .toBe(true);

    const capturedLine = consoleErrors.find((line) => line.includes('Failed to load planning presets'));
    if (!capturedLine) throw new Error('expected a captured console.error line');
    expect(capturedLine).toContain('simulated getPlanningPresets IPC failure');

    await page.evaluate((text) => {
      const overlay = document.createElement('div');
      overlay.setAttribute('data-testid', 'console-proof-overlay');
      overlay.textContent = text;
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:99999;background:#111;color:#0f0;font:14px monospace;padding:24px;white-space:pre-wrap;';
      document.body.appendChild(overlay);
    }, capturedLine);

    await captureScreenshot(page, 'planning-presets-load-failure');
  });
});
