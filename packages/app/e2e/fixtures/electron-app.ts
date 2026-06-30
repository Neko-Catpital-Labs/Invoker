/**
 * Shared Electron app fixture for E2E tests.
 *
 * Launches the built Electron app and provides the first window page.
 * Handles platform-specific flags (Linux --no-sandbox) and cleanup.
 * Set INVOKER_E2E_KEEP_TMP=1 to skip deleting the temp INVOKER_DB_DIR after each test (debugging).
 */

import type { TaskStateChanges } from '@invoker/workflow-core';
import { resolveRepoRoot } from '@invoker/contracts';
import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { stringify as yamlStringify } from 'yaml';

export type ElectronFixtures = {
  electronApp: ElectronApplication;
  guiOwnerMode: string;
  /** When true, the app's embedded terminal backend throws on spawn (fault injection). */
  breakTerminalSpawn: boolean;
  page: Page;
  testDir: string;
};

const repoRoot = resolveRepoRoot(__dirname);

async function removeTestDir(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

export const test = base.extend<ElectronFixtures>({
  guiOwnerMode: [process.env.INVOKER_E2E_GUI_OWNER_MODE ?? 'gui', { option: true }],
  breakTerminalSpawn: [false, { option: true }],

  testDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-'));
    await use(dir);
    if (process.env.INVOKER_E2E_KEEP_TMP !== '1') {
      await removeTestDir(dir);
    }
  },

  electronApp: async ({ guiOwnerMode, breakTerminalSpawn, testDir }, use) => {
    // Dummy `claude` on PATH + fix command — same as scripts/e2e-dry-run (no real CLI).
    const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
    const stubDir = path.join(testDir, 'claude-stub');
    const markerRoot = path.join(testDir, 'e2e-markers');
    const configPath = path.join(testDir, 'e2e-config.json');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const electronUserDataDir = path.join(testDir, 'electron-user-data');
    await fs.mkdir(stubDir, { recursive: true });
    await fs.mkdir(markerRoot, { recursive: true });
    await fs.mkdir(electronUserDataDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');
    try {
      await fs.symlink(claudeMarker, path.join(stubDir, 'claude'));
    } catch {
      // Windows / EPERM: fix path still uses INVOKER_CLAUDE_FIX_COMMAND; prompt tasks may hit real claude.
    }
    const codexStub = path.join(stubDir, 'codex');
    writeFileSync(codexStub, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "resume" ]]; then
  if [[ ! -t 0 || ! -t 1 ]]; then
    echo "stdin is not a terminal" >&2
    exit 12
  fi
  session_id="\${@: -1}"
  sleep 1
  echo "TTY OK: codex resume \${session_id:-}"
  exit 0
fi
if [[ "\${1:-}" == "exec" ]]; then
  echo '{"type":"session_configured","session_id":"codex-e2e-exec"}'
  echo '{"type":"turn_context","cwd":"'"$PWD"'"}'
  echo '{"type":"task_complete","last_agent_message":"Codex E2E exec complete"}'
  exit 0
fi
echo "unsupported codex args: $*" >&2
exit 64
`, 'utf8');
    chmodSync(codexStub, 0o755);
    const pathEnv = `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`;
    const forceReadOnlyStatus = guiOwnerMode === 'read-only-status';
    // Playwright's `use.video` option only applies to browser contexts, so the
    // Electron walkthrough video must be requested at launch time.
    const recordVideo = process.env.CAPTURE_VIDEO
      ? { recordVideo: { dir: path.resolve(__dirname, '..', 'test-results', 'videos') } }
      : {};
    const app = await electron.launch({
      ...recordVideo,
      args: [
        ...(process.platform === 'linux'
          ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
          : []),
        `--user-data-dir=${electronUserDataDir}`,
        path.resolve(__dirname, '..', '..', 'dist', 'main.js'),
      ],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TZ: 'UTC',
        INVOKER_GUI_OWNER_MODE: forceReadOnlyStatus ? 'gui' : guiOwnerMode,
        INVOKER_DB_DIR: testDir,
        INVOKER_IPC_SOCKET: ipcSocketPath,
        INVOKER_ALLOW_DELETE_ALL: '1',
        INVOKER_E2E_ENABLE_COMPOSITOR: '1',
        INVOKER_REPO_CONFIG_PATH: configPath,
        INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS:
          process.env.INVOKER_E2E_STANDALONE_OWNER_IDLE_TIMEOUT_MS ?? '10000',
        INVOKER_EMBEDDED_TERMINAL_BACKEND:
          process.env.INVOKER_E2E_EMBEDDED_TERMINAL_BACKEND ?? 'pty',
        INVOKER_E2E_MARKER_ROOT: markerRoot,
        INVOKER_TEST_FIXED_NOW: '2025-01-01T00:00:00.000Z',
        INVOKER_CLAUDE_COMMAND: claudeMarker,
        INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
        ...(breakTerminalSpawn ? { INVOKER_E2E_BREAK_TERMINAL_SPAWN: '1' } : {}),
        ...(forceReadOnlyStatus ? { INVOKER_E2E_FORCE_READ_ONLY_STATUS: '1' } : {}),
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
    try {
      await page.evaluate(async () => {
        await window.invoker.deleteAllWorkflows();
      });
    } catch {
      // Best-effort cleanup; the test failure itself should remain the signal.
    }
  },
});

export { expect };

/** Minimal plan with two command tasks for testing UI rendering and lifecycle.
 *  Commands sleep briefly so the "running" state is visible long enough to capture. */
/**
 * Local bare repo created by global-setup.ts. All E2E plans use this so
 * WorktreeExecutor can clone without hitting the network.
 */
export const E2E_BARE_REPO = process.env.INVOKER_E2E_BARE_REPO ?? '/tmp/invoker-e2e-repo.git';
export const E2E_REPO_URL = pathToFileURL(E2E_BARE_REPO).href;

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

async function selectWorkflowNode(page: Page, workflowId?: string): Promise<void> {
  const miniDag = page.getByTestId('selected-workflow-mini-dag');
  const workflowNode = workflowId ? page.getByTestId(`workflow-node-${workflowId}`) : page.locator('[data-testid^="workflow-node-"]').first();
  await workflowNode.waitFor({ state: 'attached', timeout: 10000 });
  await workflowNode.dispatchEvent('click', { bubbles: true });
  await miniDag.waitFor({ state: 'visible', timeout: 10000 });
}

/** Select the first workflow node so the reskinned mini-DAG renders task nodes. */
export async function selectFirstWorkflow(page: Page): Promise<void> {
  await selectWorkflowNode(page);
}

/** Load a plan into the running app via the IPC bridge and wait for its mini-DAG to render. */
export async function loadPlan(page: Page, plan: { tasks: readonly { id: string }[] }): Promise<void> {
  const planYaml = yamlStringify(plan);
  const beforeIds = await page.evaluate(async () => {
    const workflows = await window.invoker.listWorkflows();
    return workflows.map((workflow: { id: string }) => workflow.id);
  });
  await page.evaluate((p) => window.invoker.loadPlan(p), planYaml);
  const workflowId = await page.evaluate(async (knownIds) => {
    const workflows = await window.invoker.listWorkflows();
    const created = workflows.find((workflow: { id: string }) => !knownIds.includes(workflow.id));
    return created?.id ?? workflows[workflows.length - 1]?.id ?? null;
  }, beforeIds);
  await page.waitForFunction(
    (expectedTaskCount) => window.invoker.getTasks().then((result) => {
      const tasks = Array.isArray(result) ? result : result.tasks;
      const workflows = Array.isArray(result) ? [] : result.workflows ?? [];
      return tasks.length >= expectedTaskCount && workflows.length > 0;
    }),
    plan.tasks.length,
    { timeout: 10000 },
  );
  await page.getByRole('button', { name: 'Refresh' }).click();
  await selectWorkflowNode(page, workflowId ?? undefined);
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

function matchesTaskId(actualId: string, requestedId: string): boolean {
  return actualId === requestedId || actualId.endsWith(`/${requestedId}`);
}

export function findTaskByIdSuffix(tasks: Array<any>, taskId: string) {
  return tasks.find((task) => matchesTaskId(task.id, taskId));
}

export async function resolveTaskId(page: Page, taskId: string): Promise<string> {
  const tasks = await getTasks(page);
  const task = findTaskByIdSuffix(tasks, taskId);
  if (!task) {
    throw new Error(`Task "${taskId}" not found`);
  }
  return task.id;
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
    const task = tasks.find((t: any) => matchesTaskId(t.id, taskId));
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
    const task = tasks.find((t: any) => matchesTaskId(t.id, taskId));
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
 * Screenshot baselines were captured against a 1200x771 content viewport.
 * Electron frame metrics can drift by a pixel across versions/window managers,
 * so pin the content viewport in the test harness before visual assertions.
 */
async function ensureScreenshotViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 771 });
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
  await ensureScreenshotViewport(page);
  await waitForStableUI(page);
  await expect(page).toHaveScreenshot(`${name}.png`, { timeout: 0 });
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
  await ensureScreenshotViewport(page);
  await waitForStableUI(page);
  await page.screenshot({
    path: path.join(dir, `${name}.png`),
    timeout: 60000,
  });
}
