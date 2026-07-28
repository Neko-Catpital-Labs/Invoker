import * as path from 'node:path';
import { test, expect } from './fixtures/electron-app.js';

const SHOT_DIR = process.env.CLAUDE_PRESET_SHOT_DIR ?? path.resolve(__dirname, '..', 'visual-proof', 'claude-preset');

test('planning chat Agent dropdown lists Claude', async ({ page }) => {
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });

  await page.getByRole('button', { name: 'Options' }).click();

  const harnessSelect = page.getByTestId('invoker-terminal-harness');
  await expect(harnessSelect).toBeVisible({ timeout: 10000 });

  const optionLabels = await harnessSelect.locator('option').allTextContents();
  expect(optionLabels).toContain('Claude');

  await harnessSelect.selectOption({ label: 'Claude' });
  await expect(harnessSelect).toHaveValue('claude');

  await page.screenshot({ path: path.join(SHOT_DIR, 'claude-selected.png') });
});
