import { _electron as electron, expect, test } from '@playwright/test';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';
import type { Page } from '@playwright/test';

import { E2E_REPO_URL } from './fixtures/electron-app.js';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

async function launchElectronApp(testDir: string, extraEnv?: Record<string, string>) {
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
  return electron.launch({
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
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ...(extraEnv ?? {}),
    },
  });
}

function buildPlan(index: number) {
  return {
    name: `Startup Perf Plan ${index}`,
    repoUrl: E2E_REPO_URL,
    onFinish: 'none' as const,
    tasks: Array.from({ length: 7 }, (_, taskIndex) => ({
      id: `task-${index}-${taskIndex}`,
      description: `Task ${index}-${taskIndex}`,
      command: `echo task-${index}-${taskIndex}`,
      dependencies: taskIndex === 0 ? [] : [`task-${index}-${taskIndex - 1}`],
    })),
  };
}

async function waitForGraphVisible(page: Page, taskSuffix: string, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  await page.locator(`.react-flow__node[data-testid$="${taskSuffix}"]`).first().waitFor({
    state: 'visible',
    timeout: timeoutMs,
  });
  return Date.now() - startedAt;
}

function parseActivityPayload(message: string): Record<string, unknown> | null {
  try {
    return JSON.parse(message) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function dragGraphAndAssertViewportMoves(page: Page): Promise<void> {
  const viewport = page.locator('.react-flow__viewport').first();
  const pane = page.locator('.react-flow__pane').first();
  const before = await viewport.evaluate((el) => getComputedStyle(el).transform);
  const box = await pane.boundingBox();
  if (!box) {
    throw new Error('React Flow pane is not visible');
  }
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 + 140, box.y + box.height * 0.5, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const after = await viewport.evaluate((el) => getComputedStyle(el).transform);
  expect(after).not.toBe(before);
}

test('non-empty persisted startup stays responsive and avoids initial db-poll replay flood', async () => {
  const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-startup-nonempty-'));
  const workflowCount = 14;
  const tasksPerWorkflow = 8;
  const expectedTaskCount = workflowCount * tasksPerWorkflow;
  const initialWorkflowIndex = workflowCount - 1;
  try {
    const seedApp = await launchElectronApp(testDir);
    try {
      const page = await seedApp.firstWindow({ timeout: 5000 });
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 5000 });

      for (let index = 0; index < workflowCount; index += 1) {
        const planYaml = yamlStringify(buildPlan(index));
        await page.evaluate(async (planText) => {
          await window.invoker.loadPlan(planText);
        }, planYaml);
      }

      const seeded = await page.evaluate(() => window.invoker.getTasks(true));
      const seededTasks = Array.isArray(seeded) ? seeded : seeded.tasks;
      expect(seededTasks.length).toBe(expectedTaskCount);
    } finally {
      await seedApp.close();
    }

    const startedAt = Date.now();
    const app = await launchElectronApp(testDir, {
      INVOKER_TEST_RESUME_PENDING_DELAY_MS: '3000',
    });
    try {
      const page = await app.firstWindow({ timeout: 3000 });
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(3000);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 5000 });

      await waitForGraphVisible(page, `task-${initialWorkflowIndex}-0`, 5000);
      await dragGraphAndAssertViewportMoves(page);

      const result = await page.evaluate(async () => {
        const tasksResult = await window.invoker.getTasks(true);
        const tasks = Array.isArray(tasksResult) ? tasksResult : tasksResult.tasks;
        const perf = await window.invoker.getUiPerfStats();
        const activityLogs = await window.invoker.getActivityLogs();
        return { taskCount: tasks.length, perf, activityLogs };
      });

      const startupEntries = result.activityLogs
        .filter((entry) => entry.source === 'startup-phase' || entry.source === 'ui-perf')
        .map((entry) => ({ source: entry.source, payload: parseActivityPayload(entry.message) }))
        .filter((entry) => entry.payload !== null);

      const windowShow = [...startupEntries]
        .reverse()
        .find((entry) => entry.source === 'startup-phase' && entry.payload?.phase === 'window.show')
        ?.payload;
      const graphVisible = startupEntries.find(
        (entry) =>
          entry.source === 'ui-perf'
          && entry.payload?.metric === 'startup_graph_visible'
          && entry.payload?.nodeCount === tasksPerWorkflow,
      )?.payload;

      expect(windowShow).toBeTruthy();
      expect(graphVisible).toBeTruthy();
      expect(Number(graphVisible?.processElapsedMs) - Number(windowShow?.elapsedMs)).toBeLessThan(200);
      expect(Number(graphVisible?.nodeCount)).toBe(tasksPerWorkflow);

      expect(result.taskCount).toBe(expectedTaskCount);
      expect(result.perf.dbPollCreated).toBe(0);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
