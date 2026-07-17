import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron, type Page } from '@playwright/test';
import { resolveRepoRoot } from '@invoker/contracts';
import { stringify as yamlStringify } from 'yaml';

import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';
import {
  E2E_REPO_URL,
  TEST_PLAN,
  expect,
  loadPlan,
  startPlan,
  test,
} from './fixtures/electron-app.js';
import {
  activityLogWatermark,
  maxPayloadNumber,
  numberOrZero,
  uiPerfPayloadsSince,
} from './fixtures/ui-perf.js';

test.use({ guiOwnerMode: process.env.INVOKER_E2E_GUI_OWNER_MODE ?? 'daemon' });

const execFileAsync = promisify(execFile);
const repoRoot = resolveRepoRoot(__dirname);
const RESPONSIVE_INTERACTION_TIMEOUT_MS = 15000;
const MAX_INSPECTOR_TOGGLE_MS = 5000;
const HEADLESS_DELEGATED_WORKFLOW_COUNT = 8;
const MAX_RETRY_BURST_WALL_MS = 120000;
const MAX_RENDERER_EVENT_LOOP_LAG_MS = 1000;
const MAX_RENDERER_LONG_TASK_MS = 1500;

const HEADLESS_HERD_BUDGETS = {
  maxInspectorToggleMs: MAX_INSPECTOR_TOGGLE_MS,
  maxRetryBurstWallMs: MAX_RETRY_BURST_WALL_MS,
  delegatedWorkflowCount: HEADLESS_DELEGATED_WORKFLOW_COUNT,
  minRetryCommandCount: HEADLESS_DELEGATED_WORKFLOW_COUNT + 1,
  maxRendererEventLoopLagMs: MAX_RENDERER_EVENT_LOOP_LAG_MS,
  maxRendererLongTaskMs: MAX_RENDERER_LONG_TASK_MS,
};

async function ensureHeadlessTestConfig(testDir: string): Promise<void> {
  await writeFile(path.join(testDir, 'e2e-config.json'), JSON.stringify({ autoFixRetries: 0 }), 'utf8');
}

function headlessTestEnv(testDir: string): NodeJS.ProcessEnv {
  const configPath = path.join(testDir, 'e2e-config.json');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  return {
    ...process.env,
    NODE_ENV: 'test',
          INVOKER_TEST_WORKFLOW_IDS: '1',
    TZ: 'UTC',
    INVOKER_DB_DIR: testDir,
    INVOKER_IPC_SOCKET: ipcSocketPath,
    INVOKER_REPO_CONFIG_PATH: configPath,
  };
}

async function runHeadlessClient(testDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  await ensureHeadlessTestConfig(testDir);
  const clientPath = path.join(repoRoot, 'packages', 'app', 'dist', 'headless-client.js');
  return await execFileAsync('node', [clientPath, ...args], {
    cwd: repoRoot,
    env: headlessTestEnv(testDir),
    maxBuffer: 10 * 1024 * 1024,
  });
}

function parseWorkflowId(stdout: string): string {
  const delegated = stdout.match(/Delegated to owner — workflow: (wf-[^\s]+)/);
  if (delegated?.[1]) return delegated[1];
  const direct = stdout.match(/Workflow ID: (wf-[^\s]+)/);
  if (direct?.[1]) return direct[1];
  throw new Error(`No workflow id found in stdout:\n${stdout}`);
}

function expectDelegated(stdout: string): void {
  expect(stdout).toContain('Delegated to owner');
}

function parseJsonStdout(stdout: string): Record<string, unknown> {
  const line = stdout.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith('{'));
  if (!line) throw new Error(`No JSON object found in stdout:\n${stdout}`);
  return JSON.parse(line) as Record<string, unknown>;
}

async function measureInspectorToggleResponsive(page: Page, timeoutMs: number, label: string): Promise<number> {
  const sidebarToggle = page.getByTestId('sidebar-collapse-toggle');
  const startedAt = Date.now();
  try {
    await expect(async () => {
      await expect(sidebarToggle).toBeVisible({ timeout: 1000 });
      const initialLabel = await sidebarToggle.getAttribute('aria-label');
      await sidebarToggle.click();
      if (initialLabel) {
        await expect(sidebarToggle).not.toHaveAttribute('aria-label', initialLabel, { timeout: 1000 });
      }
      await sidebarToggle.click();
      if (initialLabel) {
        await expect(sidebarToggle).toHaveAttribute('aria-label', initialLabel, { timeout: 1000 });
      }
    }).toPass({ timeout: timeoutMs });
  } catch (err) {
    console.log(`HEADLESS_THUNDERING_HERD_INTERACTION_FAILURE=${JSON.stringify({
      label,
      durationMs: Date.now() - startedAt,
      timeoutMs,
      error: err instanceof Error ? err.message : String(err),
    })}`);
    throw err;
  }
  return Date.now() - startedAt;
}

test.describe('Headless thundering herd', () => {
  test('burst headless restarts do not spawn headless electron herds or freeze the UI', async ({ page, testDir }) => {
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);
    await page.locator('.react-flow__node[data-testid$="task-alpha"]').waitFor({ state: 'visible', timeout: 10000 });

    // Discover the active workflow through the renderer bridge API
    // (listWorkflows) rather than reaching into task config internals.
    // This is the owner-boundary-compliant discovery path — the renderer
    // exposes it via IPC without crossing into persistence directly.
    const workflows = await page.evaluate(() => window.invoker.listWorkflows());
    expect(workflows.length).toBeGreaterThan(0);
    const currentWorkflowId = workflows[0].id as string;

    const herdPlan = {
      name: 'Headless Herd Seed',
      repoUrl: E2E_REPO_URL,
      onFinish: 'none' as const,
      tasks: [
        {
          id: 'burst-root',
          description: 'Burst root',
          command: 'sleep 1 && echo burst-root',
          dependencies: [],
        },
      ],
    };
    const planPath = path.join(testDir, 'headless-herd-plan.yaml');
    await writeFile(planPath, yamlStringify(herdPlan), 'utf8');

    const workflowIds = new Set<string>();
    workflowIds.add(currentWorkflowId);
    for (let i = 0; i < HEADLESS_DELEGATED_WORKFLOW_COUNT; i += 1) {
      const result = await runHeadlessClient(testDir, ['run', planPath, '--no-track']);
      expectDelegated(result.stdout);
      // Use the workflow id echoed by this exact submission. Querying shared
      // persisted state from the app layer both violates the owner boundary
      // and is ambiguous when many workflows are created concurrently.
      const workflowId = parseWorkflowId(result.stdout);
      workflowIds.add(workflowId);
    }

    await page.waitForTimeout(500);

    const perfWatermark = await activityLogWatermark(page);
    const retryBurstStartedAt = Date.now();
    const burst = Array.from(workflowIds).map((workflowId) =>
      runHeadlessClient(testDir, ['retry', workflowId, '--no-track']),
    );

    const firstInteractionMs = await measureInspectorToggleResponsive(
      page,
      RESPONSIVE_INTERACTION_TIMEOUT_MS,
      'during_retry_burst',
    );

    await page.waitForTimeout(1500);

    const secondInteractionMs = await measureInspectorToggleResponsive(
      page,
      RESPONSIVE_INTERACTION_TIMEOUT_MS,
      'after_retry_burst',
    );

    const retryResults = await Promise.all(burst);
    const retryBurstWallMs = Date.now() - retryBurstStartedAt;
    for (const result of retryResults) {
      expectDelegated(result.stdout);
    }

    const perf = await page.evaluate(async () => await window.invoker.getUiPerfStats());
    const perfPayloads = await uiPerfPayloadsSince(page, perfWatermark);
    const delegatedPerf = parseJsonStdout(
      (await runHeadlessClient(testDir, ['query', 'ui-perf', '--output', 'json'])).stdout,
    );
    const evidence = {
      workflowCount: workflowIds.size,
      retryCommandCount: burst.length,
      retryBurstWallMs,
      firstInteractionMs,
      secondInteractionMs,
      perf,
      perfPayloads,
      delegatedPerf,
      budgets: HEADLESS_HERD_BUDGETS,
    };
    console.log(`HEADLESS_THUNDERING_HERD_BENCH_RESULT=${JSON.stringify(evidence)}`);

    const evidenceMessage = JSON.stringify(evidence);
    expect(burst.length, evidenceMessage).toBeGreaterThanOrEqual(HEADLESS_DELEGATED_WORKFLOW_COUNT + 1);
    expect(retryBurstWallMs, evidenceMessage).toBeLessThanOrEqual(MAX_RETRY_BURST_WALL_MS);
    expect(firstInteractionMs, evidenceMessage).toBeLessThanOrEqual(MAX_INSPECTOR_TOGGLE_MS);
    expect(secondInteractionMs, evidenceMessage).toBeLessThanOrEqual(MAX_INSPECTOR_TOGGLE_MS);
    expect(numberOrZero(perf.maxRendererEventLoopLagMs), evidenceMessage).toBeLessThanOrEqual(MAX_RENDERER_EVENT_LOOP_LAG_MS);
    expect(numberOrZero(perf.maxRendererLongTaskMs), evidenceMessage).toBeLessThanOrEqual(MAX_RENDERER_LONG_TASK_MS);
    expect(maxPayloadNumber(perfPayloads, 'renderer_event_loop_lag', 'lagMs'), evidenceMessage).toBeLessThanOrEqual(MAX_RENDERER_EVENT_LOOP_LAG_MS);
    expect(maxPayloadNumber(perfPayloads, 'renderer_long_task', 'durationMs'), evidenceMessage).toBeLessThanOrEqual(MAX_RENDERER_LONG_TASK_MS);
    expect(delegatedPerf.ownerMode, evidenceMessage).toBe('standalone');
  });

  test('standalone owner serves delegated headless commands from isolated test paths', async ({ testDir }) => {
    await ensureHeadlessTestConfig(testDir);
    const userDataDir = path.join(testDir, 'owner-electron-user-data');
    await mkdir(userDataDir, { recursive: true });
    registerTrackedBrowserUserDataDir(userDataDir);

    const ownerApp = await electron.launch({
      args: [
        ...(process.platform === 'linux'
          ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
          : []),
        `--user-data-dir=${userDataDir}`,
        path.join(repoRoot, 'packages', 'app', 'dist', 'main.js'),
        '--headless',
        'owner-serve',
      ],
      env: {
        ...headlessTestEnv(testDir),
        INVOKER_HEADLESS_STANDALONE: '1',
        INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS: '60000',
        INVOKER_USER_DATA_DIR: userDataDir,
      },
    });

    try {
      await expect(async () => {
        const result = await runHeadlessClient(testDir, ['query', 'ui-perf', '--output', 'json']);
        const stats = parseJsonStdout(result.stdout);
        expect(stats.ownerMode).toBe('standalone');
      }).toPass({ timeout: 20000 });

      const daemonPlan = {
        name: 'Standalone Owner Delegation',
        repoUrl: E2E_REPO_URL,
        onFinish: 'none' as const,
        tasks: [
          {
            id: 'daemon-root',
            description: 'Daemon root',
            command: 'echo daemon-root',
            dependencies: [],
          },
        ],
      };
      const planPath = path.join(testDir, 'standalone-owner-plan.yaml');
      await writeFile(planPath, yamlStringify(daemonPlan), 'utf8');

      const runResult = await runHeadlessClient(testDir, ['run', planPath, '--no-track']);
      expectDelegated(runResult.stdout);
      expect(parseWorkflowId(runResult.stdout)).toMatch(/^wf-/);

      const queue = await runHeadlessClient(testDir, ['query', 'queue', '--output', 'json']);
      const queueStatus = parseJsonStdout(queue.stdout);
      expect(Array.isArray(queueStatus.running)).toBe(true);
      expect(Array.isArray(queueStatus.queued)).toBe(true);
    } finally {
      await ownerApp.close().catch(() => undefined);
    }
  });
});
