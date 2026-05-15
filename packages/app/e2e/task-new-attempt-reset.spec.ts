import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import { stringify as yamlStringify } from 'yaml';
import { E2E_REPO_URL } from './fixtures/electron-app.js';

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
  const result = await page.evaluate(() => window.invoker.getTasks(true));
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
  const app = await electron.launch({
    args: launchArgs(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TZ: 'UTC',
      INVOKER_DB_DIR: testDir,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_REPO_CONFIG_PATH: configPath,
    },
  });
  const page = await app.firstWindow();
  await waitForInvoker(page);
  return { app, page };
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
    try {
      const launched = await launchApp(testDir, configPath);
      app = launched.app;
      let page = launched.page;

      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });
      await page.evaluate((planYaml) => window.invoker.loadPlan(planYaml), yamlStringify(RESET_PLAN));

      const loaded = await waitForTask(page, 'slow-task', (task) => task.status === 'pending');
      const oldAttemptId = `${loaded.id}-old-attempt`;
      const staleTs = '2025-01-01T00:00:00.000Z';
      await app.close();
      app = undefined;
      await seedStaleLaunchAttempt(dbPath, loaded.id, oldAttemptId, new Date(staleTs));

      const relaunchedApp = await launchApp(testDir, configPath);
      app = relaunchedApp.app;
      page = relaunchedApp.page;

      const staleBeforeResume = await waitForTask(
        page,
        'slow-task',
        (task) =>
          task.status === 'pending'
          && task.execution?.phase === 'launching'
          && task.execution?.selectedAttemptId === oldAttemptId,
      );
      expect(staleBeforeResume.execution.selectedAttemptId).toBe(oldAttemptId);

      await page.evaluate(() => window.invoker.resumeWorkflow());

      const relaunched = await waitForTask(
        page,
        'slow-task',
        (task) =>
          task.status === 'running'
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
      expect(newAttempt?.status).toBe('running');
    } finally {
      await app?.close().catch(() => undefined);
      if (process.env.INVOKER_E2E_KEEP_TMP !== '1') {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});
