/**
 * Shared Electron app fixture for E2E tests.
 *
 * Launches the built Electron app and provides the first window page.
 * Handles platform-specific flags (Linux --no-sandbox) and cleanup.
 * Set INVOKER_E2E_KEEP_TMP=1 to skip deleting the temp INVOKER_DB_DIR after each test (debugging).
 */

import type { TaskStateChanges } from '@invoker/core';
import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';

export type ElectronFixtures = {
  electronApp: ElectronApplication;
  page: Page;
  testDir: string;
};

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

export const test = base.extend<ElectronFixtures>({
  testDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-'));
    await use(dir);
    if (process.env.INVOKER_E2E_KEEP_TMP !== '1') {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  electronApp: async ({ testDir }, use) => {
    // Dummy `claude` on PATH + fix command — same as scripts/e2e-dry-run (no real CLI).
    const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
    const stubDir = path.join(testDir, 'claude-stub');
    const markerRoot = path.join(testDir, 'e2e-markers');
    await fs.mkdir(stubDir, { recursive: true });
    await fs.mkdir(markerRoot, { recursive: true });
    try {
      await fs.symlink(claudeMarker, path.join(stubDir, 'claude'));
    } catch {
      // Windows / EPERM: fix path still uses INVOKER_CLAUDE_FIX_COMMAND; prompt tasks may hit real claude.
    }
    const pathEnv = `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`;
    const app = await electron.launch({
      args: [
        ...(process.platform === 'linux'
          ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
          : []),
        path.resolve(__dirname, '..', '..', 'dist', 'main.js'),
      ],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        INVOKER_DB_DIR: testDir,
        INVOKER_E2E_MARKER_ROOT: markerRoot,
        INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
        PATH: pathEnv,
      },
    });
    await use(app);
    await app.close();
  },

  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });

    // Clear state from previous runs and reload for clean React state
    await page.evaluate(async () => {
      await window.invoker.clear();
      await window.invoker.deleteAllWorkflows();
    });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });

    await use(page);
  },
});

export { expect };

/** Minimal plan with two command tasks for testing UI rendering and lifecycle.
 *  Commands sleep briefly so the "running" state is visible long enough to capture. */
/**
 * Local bare repo created by global-setup.ts. All E2E plans use this so
 * WorktreeFamiliar can clone without hitting the network.
 */
export const E2E_REPO_URL = 'file:///tmp/invoker-e2e-repo.git';

export const TEST_PLAN = {
  name: 'E2E Test Plan',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'task-alpha',
      description: 'First test task',
      command: 'sleep 5 && echo hello-alpha',
      dependencies: [],
    },
    {
      id: 'task-beta',
      description: 'Second test task depending on alpha',
      command: 'sleep 3 && echo hello-beta',
      dependencies: ['task-alpha'],
    },
    {
      id: 'task-gamma',
      description: 'Reconciliation task for testing',
      command: 'sleep 2 && echo hello-gamma',
      dependencies: ['task-beta'],
      experimentVariants: [
        { id: 'variant-a', description: 'Variant A', command: 'echo A' },
        { id: 'variant-b', description: 'Variant B', command: 'echo B' },
      ],
    },
  ],
};

/** Load a plan into the running app via the IPC bridge and wait for DAG to render. */
export async function loadPlan(page: Page, plan: typeof TEST_PLAN): Promise<void> {
  const planYaml = yamlStringify(plan);
  await page.evaluate((p) => window.invoker.loadPlan(p), planYaml);
  await page.locator(`.react-flow__node[data-testid$="${plan.tasks[0].id}"]`).first().waitFor({ state: 'visible', timeout: 10000 });
}

/** Test-only: inject task status/execution into persistence and UI without running commands. */
export async function injectTaskStates(
  page: Page,
  updates: Array<{ taskId: string; changes: TaskStateChanges }>,
): Promise<void> {
  const resolvedUpdates = await page.evaluate(async (u) => {
    const result = await window.invoker.getTasks();
    const tasks = Array.isArray(result) ? result : result.tasks;
    const ids = tasks.map((t: { id: string }) => t.id);

    const resolveTaskId = (rawId: string): string => {
      if (ids.includes(rawId)) return rawId;
      const suffixMatches = ids.filter((id: string) => id.endsWith(`/${rawId}`) || id.endsWith(rawId));
      return suffixMatches[0] ?? rawId;
    };

    return u.map((entry) => ({
      taskId: resolveTaskId(entry.taskId),
      changes: entry.changes,
    }));
  }, updates);

  await page.evaluate(async (u) => {
    await window.invoker.injectTaskStates!(u);
  }, resolvedUpdates);
  await page.waitForTimeout(200);
}

/** Start the loaded plan via the IPC bridge. */
export async function startPlan(page: Page): Promise<void> {
  await page.evaluate(() => window.invoker.start());
}

/** Get all current tasks via the IPC bridge. */
export async function getTasks(page: Page) {
  const result = await page.evaluate(() => window.invoker.getTasks());
  return Array.isArray(result) ? result : result.tasks;
}

/** Wait for a specific task to reach a given status via polling. */
export async function waitForTaskStatus(
  page: Page,
  taskId: string,
  status: string,
  timeoutMs = 55000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const task = tasks.find((t: any) => t.id === taskId);
    if (task && task.status === status) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`Task "${taskId}" did not reach status "${status}" within ${timeoutMs}ms`);
}

/** Wait for a task to leave pending (running, completed, or failed). */
export async function waitForTaskStarted(
  page: Page,
  taskId: string,
  timeoutMs = 30000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const task = tasks.find((t: any) => t.id === taskId);
    if (task && task.status !== 'pending') return task.status;
    await page.waitForTimeout(100);
  }
  throw new Error(`Task "${taskId}" did not leave pending within ${timeoutMs}ms`);
}

/** Wait for UI animations to settle before capturing. */
export async function waitForStableUI(page: Page): Promise<void> {
  await page.evaluate(() =>
    new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  );
  await page.waitForTimeout(300);
}

/**
 * Assert a named screenshot matches the committed baseline (toHaveScreenshot).
 * Used by normal regression tests. Viewport capture (not fullPage) to match
 * the Playwright config's toHaveScreenshot defaults.
 */
export async function assertPageScreenshot(page: Page, name: string): Promise<void> {
  // Skip pixel-level screenshot comparison on CI (no Linux baselines committed).
  // DOM assertions in the calling test still run.
  if (process.env.CI) return;
  await waitForStableUI(page);
  await expect(page).toHaveScreenshot(`${name}.png`, { timeout: 20_000 });
}

/**
 * Capture a named screenshot to disk. No-op unless CAPTURE_MODE env var is set.
 * Used by scripts/ui-visual-proof.sh for merge-gate before/after capture;
 * normal regression tests use assertPageScreenshot / toHaveScreenshot instead.
 */
export async function captureScreenshot(page: Page, name: string): Promise<void> {
  const mode = process.env.CAPTURE_MODE;
  if (!mode) return;
  const dir = path.resolve(__dirname, '..', 'visual-proof', mode);
  await fs.mkdir(dir, { recursive: true });
  await waitForStableUI(page);
  await page.screenshot({
    path: path.join(dir, `${name}.png`),
    timeout: 60000,
  });
}
