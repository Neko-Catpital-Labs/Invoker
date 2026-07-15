/**
 * Repro: clicking "Start ready work" must not crash Invoker against the
 * production ~/.invoker database.
 *
 * Run only via scripts/repro/repro-start-ready-production-click.sh
 * (sets INVOKER_REPRO_PRODUCTION_DB=1).
 */
import { _electron as electron, expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');
const INVOKER_LOG = path.join(process.env.HOME ?? '', '.invoker', 'invoker.log');
const USE_PRODUCTION_DB = process.env.INVOKER_REPRO_PRODUCTION_DB === '1';

function logWatermark(): string {
  return new Date().toISOString();
}

function uncaughtExceptionsSince(watermark: string): string[] {
  if (!fs.existsSync(INVOKER_LOG)) return [];
  try {
    const out = execSync(
      `rg "uncaughtException" ${JSON.stringify(INVOKER_LOG)} | tail -100`,
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    return out.split('\n').filter((line) => {
      if (!line.includes('uncaughtException')) return false;
      const match = line.match(/"time":"([^"]+)"/);
      return Boolean(match && match[1] >= watermark);
    });
  } catch {
    return [];
  }
}

test.describe('Start ready production click survival', () => {
  if (!USE_PRODUCTION_DB) return;

  test('clicking Start ready work keeps Electron alive', async () => {
    const watermark = logWatermark();
    const electronApp = await electron.launch({
      args: [MAIN_JS],
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      },
    });

    try {
      const page = await electronApp.firstWindow({ timeout: 90_000 });
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 60_000 });

      const startButton = page.getByTestId('rail-start-ready');
      await expect(startButton).toBeVisible({ timeout: 60_000 });
      await startButton.click();

      await page.waitForFunction(() => {
        const button = document.querySelector('[data-testid="rail-start-ready"]') as HTMLButtonElement | null;
        return button !== null && !button.disabled;
      }, null, { timeout: 120_000 });

      await page.waitForTimeout(5_000);
      const tasks = await page.evaluate(async () => {
        const result = await window.invoker.getTasks();
        return Array.isArray(result) ? result.length : result.tasks.length;
      });
      expect(tasks).toBeGreaterThan(0);

      const pid = electronApp.process()?.pid;
      expect(pid).toBeTruthy();
      if (pid) {
        execSync(`kill -0 ${pid}`);
      }

      const crashes = uncaughtExceptionsSince(watermark);
      expect(crashes, `uncaught exceptions after click:\n${crashes.join('\n')}`).toEqual([]);
    } finally {
      await electronApp.close();
    }
  });
});
