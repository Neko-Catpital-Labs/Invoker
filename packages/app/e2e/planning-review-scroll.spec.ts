import { test, expect, captureScreenshot } from './fixtures/electron-app.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

test('a long Review draft panel scrolls with the mouse wheel', async ({ page }) => {
  const planYaml = await fs.readFile(
    path.resolve(__dirname, '..', 'src', '__tests__', 'fixtures', 'planning-review-ad665bff.yaml'),
    'utf8',
  );
  await page.evaluate(async ({ yaml }) => {
    await window.invoker.setTestPlanningChatResponse({
      planYaml: yaml,
      planName: 'Reaper workers for finished e2e and admin-bypass tasks',
      reply: 'I wrote the 3-slice plan to the draft file.',
      sidecarDraft: true,
    });
  }, { yaml: planYaml });

  await page.getByTestId('sidebar-home').click();
  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByTestId('invoker-terminal-input').fill('github.com/Neko-Catpital-Labs/Invoker/');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('heading', { name: 'Review draft' })).toBeVisible();

  const reviewBody = page.getByTestId('planning-context-panel').locator(':scope > div').nth(1);
  await expect(reviewBody).toBeVisible();
  const before = await reviewBody.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    overflowY: window.getComputedStyle(element).overflowY,
  }));
  console.log(`[planning-review-scroll] before=${JSON.stringify(before)}`);
  await captureScreenshot(page, 'planning-review-scroll-before');
  if (process.env.CAPTURE_VIDEO) await page.waitForTimeout(800);

  await reviewBody.hover();
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(process.env.CAPTURE_VIDEO ? 800 : 100);

  const after = await reviewBody.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    overflowY: window.getComputedStyle(element).overflowY,
  }));
  console.log(`[planning-review-scroll] after=${JSON.stringify(after)}`);
  expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
  await captureScreenshot(page, 'planning-review-scroll-after');
});
