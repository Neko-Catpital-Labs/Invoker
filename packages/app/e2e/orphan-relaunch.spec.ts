/**
 * E2E: Orphan task reconciliation — stale in-flight tasks from a previous
 * session are failed on boot ("Application quit"), not silently relaunched.
 */

import { test as base, _electron as electron, expect, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { E2E_REPO_URL } from './fixtures/electron-app.js';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';
import { ATTEMPT_LEASE_MS } from '@invoker/contracts';
import { setTimeout as delay } from 'node:timers/promises';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

const RELAUNCH_PLAN = {
  name: 'Orphan Relaunch Test',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'fast-task',
      description: 'Completes quickly',
      command: 'echo done',
      dependencies: [],
    },
    {
      id: 'slow-task',
      description: 'Takes long enough to be interrupted',
      command: 'sleep 120',
      dependencies: ['fast-task'],
    },
  ],
};

function launchArgs(): string[] {
  return [
    ...(process.platform === 'linux'
      ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
      : []),
    MAIN_JS,
  ];
}

function findTask(tasks: Array<{ id: string; status: string; execution?: { error?: string } }>, taskId: string) {
  return tasks.find((t) => t.id === taskId || t.id.endsWith(`/${taskId}`));
}

async function waitForInvoker(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });
}

base.describe('Orphan task relaunch on restart', () => {
  base('orphaned running task is failed on app restart', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const electronUserDataDir = path.join(testDir, 'electron-user-data');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');
    rmSync(electronUserDataDir, { recursive: true, force: true });
    registerTrackedBrowserUserDataDir(electronUserDataDir);

    const env = {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_TEST_WORKFLOW_IDS: '1',
      INVOKER_GUI_OWNER_MODE: process.env.INVOKER_E2E_GUI_OWNER_MODE ?? 'gui',
      INVOKER_DB_DIR: testDir,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_USER_DATA_DIR: electronUserDataDir,
    };

    let app = await electron.launch({
      args: [`--user-data-dir=${electronUserDataDir}`, ...launchArgs()],
      env,
    });
    try {
      const page1 = await app.firstWindow();
      await waitForInvoker(page1);

      await page1.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });

      await page1.evaluate((planYaml) => window.invoker.loadPlan(planYaml), yamlStringify(RELAUNCH_PLAN));
      const loadedResult = await page1.evaluate(() => window.invoker.getTasks());
      const loadedTasks = Array.isArray(loadedResult) ? loadedResult : loadedResult.tasks;
      const loadedSlow = findTask(loadedTasks, 'slow-task');
      const loadedFast = findTask(loadedTasks, 'fast-task');
      expect(loadedSlow).toBeDefined();
      expect(loadedFast).toBeDefined();

      const staleIso = new Date(Date.now() - ATTEMPT_LEASE_MS - 1_000).toISOString();
      await page1.evaluate(async ({ slowTaskId, fastTaskId, staleIso }) => {
        await window.invoker.injectTaskStates?.([
          {
            taskId: fastTaskId,
            changes: {
              status: 'completed',
              execution: {
                phase: 'executing',
                startedAt: staleIso,
                lastHeartbeatAt: staleIso,
                launchStartedAt: staleIso,
                completedAt: staleIso,
              },
            },
          },
          {
            taskId: slowTaskId,
            changes: {
              status: 'running',
              execution: {
                phase: 'launching',
                startedAt: staleIso,
                lastHeartbeatAt: staleIso,
                launchStartedAt: staleIso,
              },
            },
          },
        ]);
      }, { slowTaskId: loadedSlow!.id, fastTaskId: loadedFast!.id, staleIso });

      await app.close();
      app = undefined as never;
      await delay(1500);

      app = await electron.launch({
        args: [`--user-data-dir=${electronUserDataDir}`, ...launchArgs()],
        env,
      });
      const page2 = await app.firstWindow();
      await waitForInvoker(page2);

      await expect.poll(async () => {
        const snapshot = await page2.evaluate(() => window.invoker.getTasks());
        const tasks = Array.isArray(snapshot) ? snapshot : snapshot.tasks;
        const slow = findTask(tasks, 'slow-task');
        return {
          status: slow?.status,
          error: slow?.execution?.error ?? null,
        };
      }, { timeout: 30_000 }).toEqual({
        status: 'failed',
        error: 'Application quit',
      });
    } finally {
      if (app) await app.close().catch(() => undefined);
      if (process.env.INVOKER_E2E_KEEP_TMP !== '1') {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});
