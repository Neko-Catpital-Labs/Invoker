import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SQLiteAdapter } from '@invoker/data-store';
import { stringify as yamlStringify } from 'yaml';
import { E2E_REPO_URL } from './fixtures/electron-app.js';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

const RESET_PLAN = {
  name: 'Task New Attempt Reset Repro',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'fast-task',
      description: 'Completes quickly',
      command: 'echo fast',
    },
    {
      id: 'slow-task',
      description: 'Long task interrupted before resume',
      command: 'sleep 60',
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

async function waitForInvoker(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });
}

function findTask(tasks: Array<{ id: string; status: string }>, taskId: string) {
  return tasks.find((task) => task.id === taskId || task.id.endsWith(`/${taskId}`));
}

async function getTasks(page: Page): Promise<any[]> {
  const result = await page.evaluate(() => window.invoker.getTasks());
  return Array.isArray(result) ? result : result.tasks;
}

async function waitForTask(page: Page, taskId: string, predicate: (task: any) => boolean): Promise<any> {
  const deadline = Date.now() + 45_000;
  let task: any;
  while (Date.now() < deadline) {
    task = findTask(await getTasks(page), taskId);
    if (task && predicate(task)) return task;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${taskId}; last=${JSON.stringify(task)}`);
}

async function launchApp(testDir: string, configPath: string): Promise<{ app: ElectronApplication; page: Page }> {
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  const electronUserDataDir = path.join(testDir, 'electron-user-data');
  registerTrackedBrowserUserDataDir(electronUserDataDir);
  const app = await electron.launch({
    args: [
      ...launchArgs().slice(0, -1),
      `--user-data-dir=${electronUserDataDir}`,
      MAIN_JS,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
          INVOKER_TEST_WORKFLOW_IDS: '1',
      TZ: 'UTC',
      INVOKER_GUI_OWNER_MODE: process.env.INVOKER_E2E_GUI_OWNER_MODE ?? 'daemon',
      INVOKER_DB_DIR: testDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS:
        process.env.INVOKER_E2E_STANDALONE_OWNER_IDLE_TIMEOUT_MS ?? '5000',
      INVOKER_EMBEDDED_TERMINAL_BACKEND:
        process.env.INVOKER_E2E_EMBEDDED_TERMINAL_BACKEND ?? 'pty',
      INVOKER_USER_DATA_DIR: electronUserDataDir,
    },
  });
  const page = await app.firstWindow();
  await waitForInvoker(page);
  return { app, page };
}

async function closeApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const closePromise = app.close().catch(() => undefined);
  const timedOut = await Promise.race([
    closePromise.then(() => false),
    delay(5_000).then(() => true),
  ]);
  if (timedOut) {
    child.kill('SIGTERM');
    await Promise.race([closePromise, delay(2_000)]);
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  }
}

async function waitForOwnerCloseSettle(): Promise<void> {
  await delay(1_500);
}

async function waitForStandaloneOwnerExit(): Promise<void> {
  await delay(6_000);
}

async function cleanupWorkflow(page: Page | undefined): Promise<void> {
  if (!page || page.isClosed()) return;
  await page.evaluate(async () => {
    try {
      await window.invoker.stop();
    } catch {
      // Best-effort cleanup; preserve the original test failure.
    }
    try {
      await window.invoker.deleteAllWorkflows();
    } catch {
      // Best-effort cleanup; preserve the original test failure.
    }
  }).catch(() => undefined);
}

async function seedStaleLaunchAttempt(dbPath: string, taskId: string, attemptId: string, staleAt: Date): Promise<void> {
  const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
  try {
    adapter.saveAttempt({
      id: attemptId,
      nodeId: taskId,
      queuePriority: 0,
      upstreamAttemptIds: [],
      status: 'claimed',
      claimedAt: staleAt,
      startedAt: staleAt,
      lastHeartbeatAt: staleAt,
      branch: 'stale-branch',
      commit: 'stale-commit',
      workspacePath: '/tmp/stale-workspace',
      agentSessionId: 'stale-session',
      createdAt: staleAt,
    });
    adapter.updateTask(taskId, {
      status: 'pending',
      execution: {
        phase: 'launching',
        startedAt: staleAt,
        lastHeartbeatAt: staleAt,
        launchStartedAt: staleAt,
        launchCompletedAt: staleAt,
        selectedAttemptId: attemptId,
        branch: 'stale-branch',
        commit: 'stale-commit',
        workspacePath: '/tmp/stale-workspace',
        agentSessionId: 'stale-session',
        error: 'stale launch error',
        exitCode: 123,
        inputPrompt: 'stale prompt',
        pendingFixError: 'stale fix error',
      },
    });
  } finally {
    adapter.close();
  }
}

base.describe('Task new-attempt reset repro', () => {
  base('explicit resume supersedes stale selected attempt and clears launch runtime state', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-new-attempt-reset-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const dbPath = path.join(testDir, 'invoker.db');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      const launched = await launchApp(testDir, configPath);
      app = launched.app;
      page = launched.page;

      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });
      await page.evaluate((planYaml) => window.invoker.loadPlan(planYaml), yamlStringify(RESET_PLAN));

      const loaded = await waitForTask(page, 'slow-task', (task) => task.status === 'pending');
      const oldAttemptId = `${loaded.id}-old-attempt`;
      const staleTs = '2025-01-01T00:00:00.000Z';
      await closeApp(app);
      app = undefined;
      await waitForOwnerCloseSettle();
      await seedStaleLaunchAttempt(dbPath, loaded.id, oldAttemptId, new Date(staleTs));

      const relaunchedApp = await launchApp(testDir, configPath);
      app = relaunchedApp.app;
      page = relaunchedApp.page;

      const staleBeforeResume = await waitForTask(
        page,
        'slow-task',
        (task) =>
          task.status === 'pending'
          && task.execution?.selectedAttemptId === oldAttemptId,
      );
      expect(staleBeforeResume.execution.selectedAttemptId).toBe(oldAttemptId);
      expect(new Date(staleBeforeResume.execution.startedAt).toISOString()).toBe(staleTs);

      await page.evaluate(() => window.invoker.resumeWorkflow());

      const relaunched = await waitForTask(
        page,
        'slow-task',
        (task) =>
          (task.status === 'pending' || task.status === 'running')
          && task.execution?.selectedAttemptId
          && task.execution.selectedAttemptId !== oldAttemptId
          && task.execution.phase !== 'launching',
      );
      const newAttemptId = relaunched.execution.selectedAttemptId;
      expect(newAttemptId).toBeTruthy();
      expect(newAttemptId).not.toBe(oldAttemptId);
      expect(relaunched.execution.startedAt).not.toBe(staleTs);
      expect(relaunched.execution.launchStartedAt).not.toBe(staleTs);
      expect(relaunched.execution.launchCompletedAt).not.toBe(staleTs);
      expect(relaunched.execution.workspacePath).not.toBe('/tmp/stale-workspace');
      expect(relaunched.execution.agentSessionId).toBeUndefined();
      expect(relaunched.execution.error).toBeUndefined();
      expect(relaunched.execution.exitCode).toBeUndefined();
      expect(relaunched.execution.inputPrompt).toBeUndefined();
      expect(relaunched.execution.pendingFixError).toBeUndefined();

      const graph = await page.evaluate(() => window.invoker.getActionGraph());
      const oldAttempt = graph.nodes.find((node: any) => node.attemptId === oldAttemptId);
      const newAttempt = graph.nodes.find((node: any) => node.attemptId === newAttemptId);
      expect(oldAttempt?.status).toBe('cancelled');
      expect(['pending', 'waiting', 'claimed', 'running']).toContain(newAttempt?.status);
    } finally {
      await cleanupWorkflow(page);
      if (app) {
        await closeApp(app).catch(() => undefined);
        await waitForStandaloneOwnerExit();
      }
      if (process.env.INVOKER_E2E_KEEP_TMP !== '1') {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});
