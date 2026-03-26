/**
 * Shared Electron app fixture for E2E tests.
 *
 * Launches the built Electron app and provides the first window page.
 * Handles platform-specific flags (Linux --no-sandbox) and cleanup.
 */

import type { TaskStateChanges } from '@invoker/core';
import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

export type ElectronFixtures = {
  electronApp: ElectronApplication;
  page: Page;
  testDir: string;
};

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

function cleanStaleExperimentState(): void {
  // Git-level cleanup only. DB cleanup is handled by tmpdir isolation.
  try {
    execSync('git worktree prune', { cwd: repoRoot, stdio: 'ignore' });

    const porcelain = execSync('git worktree list --porcelain', {
      cwd: repoRoot, encoding: 'utf8',
    });
    const lines = porcelain.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('branch refs/heads/experiment/')) {
        for (let j = i - 1; j >= 0; j--) {
          if (lines[j].startsWith('worktree ')) {
            const wtPath = lines[j].slice('worktree '.length);
            try { execSync(`git worktree remove --force "${wtPath}"`, { cwd: repoRoot, stdio: 'ignore' }); } catch { /* ok */ }
            break;
          }
        }
      }
    }

    execSync('git worktree prune', { cwd: repoRoot, stdio: 'ignore' });

    const branches = execSync('git branch --list "experiment/*"', {
      cwd: repoRoot, encoding: 'utf8',
    }).trim().split('\n').map(b => b.trim()).filter(Boolean);
    for (const branch of branches) {
      try { execSync(`git branch -D "${branch}"`, { cwd: repoRoot, stdio: 'ignore' }); } catch { /* ok */ }
    }
  } catch { /* ignore */ }
}

export const test = base.extend<ElectronFixtures>({
  testDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },

  electronApp: async ({ testDir }, use) => {
    cleanStaleExperimentState();
    const app = await electron.launch({
      args: [
        ...(process.platform === 'linux'
          ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
          : []),
        path.resolve(__dirname, '..', '..', 'dist', 'main.js'),
      ],
      env: { ...process.env, NODE_ENV: 'test', INVOKER_DB_DIR: testDir, INVOKER_CLAUDE_FIX_COMMAND: '/bin/true' },
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

export { expect } from '@playwright/test';

/** Minimal plan with two command tasks for testing UI rendering and lifecycle.
 *  Commands sleep briefly so the "running" state is visible long enough to capture. */
export const TEST_PLAN = {
  name: 'E2E Test Plan',
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
  ],
};

/** Load a plan into the running app via the IPC bridge and wait for DAG to render. */
export async function loadPlan(page: Page, plan: typeof TEST_PLAN): Promise<void> {
  await page.evaluate((p) => window.invoker.loadPlan(p), plan);
  await page.locator(`[data-testid="rf__node-${plan.tasks[0].id}"]`).waitFor({ state: 'visible', timeout: 10000 });
}

/** Test-only: inject task status/execution into persistence and UI without running commands. */
export async function injectTaskStates(
  page: Page,
  updates: Array<{ taskId: string; changes: TaskStateChanges }>,
): Promise<void> {
  await page.evaluate(async (u) => {
    await window.invoker.injectTaskStates!(u);
  }, updates);
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

/** Capture a named screenshot. No-op unless CAPTURE_MODE env var is set. */
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
