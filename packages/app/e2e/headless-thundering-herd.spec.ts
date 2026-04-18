import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';
import { stringify as yamlStringify } from 'yaml';

import {
  E2E_REPO_URL,
  TEST_PLAN,
  expect,
  loadPlan,
  startPlan,
  test,
} from './fixtures/electron-app.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

async function runHeadlessClient(testDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const configPath = path.join(testDir, 'e2e-config.json');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  const clientPath = path.join(repoRoot, 'packages', 'app', 'dist', 'headless-client.js');
  return await execFileAsync('node', [clientPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_DB_DIR: testDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_REPO_CONFIG_PATH: configPath,
    },
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

async function assertTaskPanelResponsive(page: Page, timeoutMs: number): Promise<void> {
  const panel = page.locator('.overflow-y-auto');
  const startedAt = Date.now();
  await expect(panel.locator('[data-testid="command-display"]')).toBeVisible({ timeout: timeoutMs });
  const interactionMs = Date.now() - startedAt;
  expect(interactionMs).toBeLessThan(timeoutMs);
}

test.describe('Headless thundering herd', () => {
  test('burst headless restarts do not spawn headless electron herds or freeze the UI', async ({ page, testDir }) => {
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);
    await page.locator('.react-flow__node[data-testid$="task-alpha"]').waitFor({ state: 'visible', timeout: 10000 });

    const pageTasks = await page.evaluate(() => window.invoker.getTasks());
    const currentTasks = Array.isArray(pageTasks) ? pageTasks : pageTasks.tasks;
    const currentWorkflowId = currentTasks[0]?.config?.workflowId as string | undefined;
    expect(currentWorkflowId).toBeTruthy();

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
    if (currentWorkflowId) workflowIds.add(currentWorkflowId);
    for (let i = 0; i < 8; i += 1) {
      const result = await runHeadlessClient(testDir, ['run', planPath, '--no-track']);
      workflowIds.add(parseWorkflowId(result.stdout));
    }

    await page.waitForTimeout(500);

    const burst = Array.from(workflowIds).map((workflowId) =>
      runHeadlessClient(testDir, ['retry', workflowId, '--no-track']),
    );

    const firstInteractionStartedAt = Date.now();
    await page.locator('.react-flow__node[data-testid$="task-alpha"]').click();
    await assertTaskPanelResponsive(page, 8000);
    expect(Date.now() - firstInteractionStartedAt).toBeLessThan(8000);

    await page.waitForTimeout(1500);

    const secondInteractionStartedAt = Date.now();
    await page.locator('.react-flow__node[data-testid$="task-alpha"]').click();
    await assertTaskPanelResponsive(page, 8000);
    expect(Date.now() - secondInteractionStartedAt).toBeLessThan(8000);

    await Promise.all(burst);

    const perf = await page.evaluate(async () => await window.invoker.getUiPerfStats());
    expect(perf.maxRendererEventLoopLagMs).toBeLessThan(1000);
    expect(perf.maxRendererLongTaskMs).toBeLessThan(1500);

    const ownerServe = await execFileAsync('bash', [
      '-lc',
      "pgrep -af '[e]lectron/dist/electron .*packages/app/dist/main.js.*--headless owner-serve' || true",
    ]);
    expect(ownerServe.stdout.trim()).toBe('');

    const retryElectrons = await execFileAsync('bash', [
      '-lc',
      "pgrep -af '[e]lectron/dist/electron .*packages/app/dist/main.js.*--headless retry ' || true",
    ]);
    expect(retryElectrons.stdout.trim()).toBe('');
  });
});
