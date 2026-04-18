import { _electron as electron, expect, test } from '@playwright/test';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const STARTUP_BUDGET_MS = 12000;

test('GUI window appears before delayed workflow mutation recovery finishes', async () => {
  const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-startup-liveness-'));
  try {
    const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
    const stubDir = path.join(testDir, 'claude-stub');
    const markerRoot = path.join(testDir, 'e2e-markers');
    const configPath = path.join(testDir, 'e2e-config.json');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    await fs.mkdir(stubDir, { recursive: true });
    await fs.mkdir(markerRoot, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');
    try {
      await fs.symlink(claudeMarker, path.join(stubDir, 'claude'));
    } catch {
      // ignore symlink failures on restricted platforms
    }

    const startedAt = Date.now();
    const electronApp = await electron.launch({
      args: [
        ...(process.platform === 'linux'
          ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
          : []),
        path.resolve(__dirname, '..', 'dist', 'main.js'),
      ],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        INVOKER_DB_DIR: testDir,
        INVOKER_IPC_SOCKET: ipcSocketPath,
        INVOKER_ALLOW_DELETE_ALL: '1',
        INVOKER_E2E_ENABLE_COMPOSITOR: '1',
        INVOKER_REPO_CONFIG_PATH: configPath,
        INVOKER_E2E_MARKER_ROOT: markerRoot,
        INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
        INVOKER_TEST_RESUME_PENDING_DELAY_MS: '15000',
        PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
    try {
      const page = await electronApp.firstWindow({ timeout: STARTUP_BUDGET_MS });
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(STARTUP_BUDGET_MS);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 5000 });
    } finally {
      await electronApp.close();
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
