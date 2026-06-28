import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron, type Page } from '@playwright/test';
import { resolveRepoRoot } from '@invoker/contracts';
import { stringify as yamlStringify } from 'yaml';

import {
  E2E_REPO_URL,
  TEST_PLAN,
  expect,
  loadPlan,
  startPlan,
  test,
} from './fixtures/electron-app.js';

test.use({ guiOwnerMode: process.env.INVOKER_E2E_GUI_OWNER_MODE ?? 'daemon' });

const execFileAsync = promisify(execFile);
const repoRoot = resolveRepoRoot(__dirname);
const RESPONSIVE_INTERACTION_TIMEOUT_MS = 15000;

async function ensureHeadlessTestConfig(testDir: string): Promise<void> {
  await writeFile(path.join(testDir, 'e2e-config.json'), JSON.stringify({ autoFixRetries: 0 }), 'utf8');
}

function headlessTestEnv(testDir: string): NodeJS.ProcessEnv {
  const configPath = path.join(testDir, 'e2e-config.json');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  return {
    ...process.env,
    NODE_ENV: 'test',
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

async function assertInspectorToggleResponsive(page: Page, timeoutMs: number): Promise<void> {
  const minimizeButton = page.getByLabel('Minimize inspector');
  const maximizeButton = page.getByLabel('Maximize inspector');
  const startedAt = Date.now();
  await expect(async () => {
    await minimizeButton.click();
    await expect(maximizeButton).toBeVisible({ timeout: 1000 });
    await maximizeButton.click();
    await expect(minimizeButton).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: timeoutMs });
  const interactionMs = Date.now() - startedAt;
  expect(interactionMs).toBeLessThan(timeoutMs);
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
    for (let i = 0; i < 8; i += 1) {
      const result = await runHeadlessClient(testDir, ['run', planPath, '--no-track']);
      expectDelegated(result.stdout);
      // Use the workflow id echoed by this exact submission. Querying shared
      // persisted state from the app layer both violates the owner boundary
      // and is ambiguous when many workflows are created concurrently.
      const workflowId = parseWorkflowId(result.stdout);
      workflowIds.add(workflowId);
    }

    await page.waitForTimeout(500);

    const burst = Array.from(workflowIds).map((workflowId) =>
      runHeadlessClient(testDir, ['retry', workflowId, '--no-track']),
    );

    const firstInteractionStartedAt = Date.now();
    await assertInspectorToggleResponsive(page, RESPONSIVE_INTERACTION_TIMEOUT_MS);
    expect(Date.now() - firstInteractionStartedAt).toBeLessThan(RESPONSIVE_INTERACTION_TIMEOUT_MS);

    await page.waitForTimeout(1500);

    const secondInteractionStartedAt = Date.now();
    await assertInspectorToggleResponsive(page, RESPONSIVE_INTERACTION_TIMEOUT_MS);
    expect(Date.now() - secondInteractionStartedAt).toBeLessThan(RESPONSIVE_INTERACTION_TIMEOUT_MS);

    const retryResults = await Promise.all(burst);
    for (const result of retryResults) {
      expectDelegated(result.stdout);
    }

    const perf = await page.evaluate(async () => await window.invoker.getUiPerfStats());
    expect(perf.maxRendererEventLoopLagMs).toBeLessThan(1000);
    expect(perf.maxRendererLongTaskMs).toBeLessThan(1500);

    const delegatedPerf = parseJsonStdout(
      (await runHeadlessClient(testDir, ['query', 'ui-perf', '--output', 'json'])).stdout,
    );
    expect(delegatedPerf.ownerMode).toBe('standalone');
  });

  test('standalone owner serves delegated headless commands from isolated test paths', async ({ testDir }) => {
    await ensureHeadlessTestConfig(testDir);
    const userDataDir = path.join(testDir, 'owner-electron-user-data');
    await mkdir(userDataDir, { recursive: true });

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
