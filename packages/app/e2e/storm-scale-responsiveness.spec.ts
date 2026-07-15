import { E2E_REPO_URL, expect, injectTaskStates, loadPlan, startPlan, test } from './fixtures/electron-app.js';
import type { Page } from '@playwright/test';
import { stringify as yamlStringify } from 'yaml';

const ACK_BUDGET_MS = 5_000;
const IPC_P95_BUDGET_MS = 20_000;
const IPC_MAX_BUDGET_MS = 25_000;
const IPC_SAMPLE_INTERVAL_MS = 100;
const IPC_WINDOW_MS = 3_000;
const UPDATE_BURSTS = 4;
const UPDATES_PER_BURST = 12;
const UPDATE_BURST_DELAY_MS = 40;
const STUCK_LAUNCH_AGE_MS = 12 * 60 * 1000;

const SCALES = [
  { name: '1x', workflowCount: 24, tasksPerWorkflow: 4, ackBudgetMs: ACK_BUDGET_MS, ipcP95BudgetMs: IPC_P95_BUDGET_MS, ipcMaxBudgetMs: IPC_MAX_BUDGET_MS },
] as const;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function measureAck(page: Page, action: () => Promise<void>, assertVisible: () => Promise<void>): Promise<number> {
  const started = await page.evaluate(() => performance.now());
  await action();
  await assertVisible();
  const ended = await page.evaluate(() => performance.now());
  return ended - started;
}


async function seedStressScene(page: Page, scale: (typeof SCALES)[number]) {
  const seeded = await page.evaluate(async (options) => {
    if (!window.invoker.seedStressFixture) {
      throw new Error('seedStressFixture is not exposed (NODE_ENV=test required)');
    }
    return window.invoker.seedStressFixture(options);
  }, {
    workflowCount: scale.workflowCount,
    tasksPerWorkflow: scale.tasksPerWorkflow,
  });
  const hitch = await page.evaluate(async () => {
    if (!window.invoker.seedMainProcessHitchFixture) {
      throw new Error('seedMainProcessHitchFixture is not exposed (NODE_ENV=test required)');
    }
    return window.invoker.seedMainProcessHitchFixture();
  });
  expect(hitch.eventCount).toBeGreaterThanOrEqual(10_000);
  await expect.poll(async () => {
    const workflows = await page.evaluate(() => window.invoker.listWorkflows());
    return workflows.length;
  }, { timeout: 120_000 }).toBe(scale.workflowCount + 1);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.locator('[data-testid^="workflow-node-"]:visible').first().waitFor({ state: 'visible', timeout: 30_000 });
  return seeded as {
    workflowCount: number;
    taskCount: number;
    running: number;
    launching: number;
    fixing: number;
    pending: number;
    failed: number;
  };
}

async function sampleQueueStatus(page: Page) {
  return page.evaluate(async () => window.invoker.getQueueStatus());
}

async function sampleWorkflowCount(page: Page): Promise<number> {
  return page.evaluate(async () => (await window.invoker.listWorkflows()).length);
}

async function streamStormBursts(page: Page, taskIds: string[]): Promise<void> {
  const phaseTemplates = ['running', 'launching', 'failed', 'pending'] as const;
  for (let burst = 0; burst < UPDATE_BURSTS; burst += 1) {
    const updates = Array.from({ length: UPDATES_PER_BURST }, (_, offset) => {
      const taskId = taskIds[(burst * UPDATES_PER_BURST + offset) % taskIds.length]!;
      const phase = phaseTemplates[(burst + offset) % phaseTemplates.length]!;
      const now = new Date();
      if (phase === 'running') {
        return {
          taskId,
          changes: {
            status: 'running',
            execution: {
              phase: 'executing',
              startedAt: now,
              lastHeartbeatAt: now,
              error: undefined,
              exitCode: undefined,
              isFixingWithAI: false,
            },
          },
        };
      }
      if (phase === 'launching') {
        return {
          taskId,
          changes: {
            status: 'pending',
            execution: {
              phase: 'launching',
              launchStartedAt: now,
              lastHeartbeatAt: now,
              error: undefined,
              exitCode: undefined,
            },
          },
        };
      }
      if (phase === 'failed') {
        return {
          taskId,
          changes: {
            status: 'failed',
            execution: {
              phase: 'executing',
              completedAt: now,
              error: `storm burst ${burst}`,
              exitCode: 1,
              isFixingWithAI: false,
            },
          },
        };
      }
      return {
        taskId,
        changes: {
          status: 'pending',
          execution: {
            phase: undefined,
            completedAt: undefined,
            error: undefined,
            exitCode: undefined,
            isFixingWithAI: false,
          },
        },
      };
    });
    await page.evaluate(async (burstUpdates) => {
      if (!window.invoker.injectTaskStates) {
        throw new Error('injectTaskStates is not exposed (NODE_ENV=test required)');
      }
      await Promise.race([
        window.invoker.injectTaskStates(burstUpdates),
        new Promise<undefined>((resolve) => setTimeout(resolve, 2_500)),
      ]);
    }, updates);
    await page.waitForTimeout(UPDATE_BURST_DELAY_MS);
  }
}

async function settleWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function recreateBurst(page: Page, limit = 4): Promise<void> {
  await page.evaluate(async (burstLimit) => {
    const workflows = await window.invoker.listWorkflows();
    const withDeadline = <T>(promise: Promise<T>) =>
      Promise.race([
        promise,
        new Promise<undefined>((resolve) => setTimeout(resolve, 2_500)),
      ]);
    await Promise.allSettled(
      workflows
        .filter((workflow) => workflow.id !== 'wf-hitch-fat')
        .slice(0, burstLimit)
        .map((workflow) => withDeadline(window.invoker.recreateWorkflow(workflow.id))),
    );
  }, limit);
}
function buildReadyRootPlan() {
  return {
    name: 'Stress Ready Root',
    repoUrl: E2E_REPO_URL,
    onFinish: 'none' as const,
    tasks: [
      {
        id: 'root',
        description: 'Ready root',
        command: 'echo ready-root',
        dependencies: [] as string[],
      },
    ],
  };
}

for (const scale of SCALES) {
  test(`storm scale responsiveness stays correct under ${scale.name}`, async ({ page }) => {
    test.setTimeout(300_000);
    const seeded = await seedStressScene(page, scale);
    const initialQueue = await sampleQueueStatus(page);
    expect(initialQueue.activeExecutionCount).toBe(seeded.running + seeded.fixing);
    expect(initialQueue.activeExecutionCount).toBeLessThanOrEqual(initialQueue.runningCount);

    const taskIds = await page.evaluate(async () => {
      const result = await window.invoker.getTasks();
      const tasks = Array.isArray(result) ? result : result.tasks;
      return tasks.map((task: { id: string }) => task.id).filter((taskId: string) => !taskId.startsWith('wf-hitch-fat/'));
    });
    expect(taskIds.length).toBeGreaterThanOrEqual(scale.workflowCount * scale.tasksPerWorkflow);

    const ipcSamples: number[] = [];
    let sampling = true;
    const sampler = (async () => {
      const hardDeadline = Date.now() + IPC_WINDOW_MS + 20_000;
      while (sampling && Date.now() < hardDeadline) {
        const rtt = await page.evaluate(async () => {
          const started = performance.now();
          await Promise.all([
            window.invoker.listWorkflows(),
            window.invoker.getWorkerStatus(),
            window.invoker.getQueueStatus(),
          ]);
          return performance.now() - started;
        });
        ipcSamples.push(rtt);
        await page.waitForTimeout(IPC_SAMPLE_INTERVAL_MS);
      }
    })();

    await page.getByTestId('sidebar-home').click();
    const workflowNode = page
      .locator('[data-testid^="workflow-node-"]:visible:not([data-testid="workflow-node-wf-hitch-fat"])')
      .first();
    await workflowNode.waitFor({ state: 'attached', timeout: 30_000 });
    await workflowNode.dispatchEvent('click', { bubbles: true });
    await expect(page.getByTestId('selected-workflow-mini-dag')).toBeVisible({ timeout: 15_000 });

    const storm = (async () => {
      await streamStormBursts(page, taskIds);
      await recreateBurst(page);
      await streamStormBursts(page, taskIds.reverse());
    })();

    let ack = await measureAck(
      page,
      async () => { await page.getByTestId('sidebar-workers').dispatchEvent('click', { bubbles: true }); },
      async () => {
        await expect(page.getByTestId('workers-rail')).toBeVisible({ timeout: scale.ackBudgetMs + 1500 });
      },
    );
    expect(ack, `sidebar-workers ack ${ack}ms at ${scale.name}`).toBeLessThanOrEqual(scale.ackBudgetMs);

    ack = await measureAck(
      page,
      async () => { await page.getByTestId('sidebar-home').dispatchEvent('click', { bubbles: true }); },
      async () => {
        await expect(page.getByTestId('workflow-graph-surface')).toBeVisible({ timeout: scale.ackBudgetMs + 1500 });
      },
    );
    expect(ack, `sidebar-home ack ${ack}ms at ${scale.name}`).toBeLessThanOrEqual(scale.ackBudgetMs);

    await settleWithTimeout(storm, 90_000, `storm ${scale.name}`);
    sampling = false;
    await settleWithTimeout(sampler, 5_000, `sampler ${scale.name}`);

    await expect.poll(async () => await sampleWorkflowCount(page), { timeout: 30_000 }).toBe(scale.workflowCount + 1);
    await expect.poll(async () => await page.locator('[data-testid="selected-workflow-mini-dag"] .react-flow__node').count(), { timeout: 30_000 }).toBeGreaterThan(0);

    const perf = await page.evaluate(async () => await window.invoker.getUiPerfStats());
    expect(perf.maxRendererEventLoopLagMs).toBeLessThan(1000);
    const postStormAck = await measureAck(
      page,
      async () => { await page.getByTestId('sidebar-workers').dispatchEvent('click', { bubbles: true }); },
      async () => {
        await expect(page.getByTestId('workers-rail')).toBeVisible({ timeout: 30_000 });
      },
    );
    expect(postStormAck, `post-storm sidebar-workers ack ${postStormAck}ms at ${scale.name}`).toBeLessThanOrEqual(scale.ackBudgetMs + 200);
    await page.getByTestId('sidebar-home').dispatchEvent('click', { bubbles: true });
    await expect(page.getByTestId('workflow-graph-surface')).toBeVisible({ timeout: 30_000 });
    const finalQueue = await sampleQueueStatus(page);
    expect(finalQueue.activeExecutionCount).toBeLessThanOrEqual(finalQueue.runningCount);

    const sorted = [...ipcSamples].sort((a, b) => a - b);
    const p95 = percentile(sorted, 95);
    const max = sorted[sorted.length - 1] ?? 0;
    expect(p95, `p95 IPC RTT ${p95.toFixed(1)}ms at ${scale.name}`).toBeLessThanOrEqual(scale.ipcP95BudgetMs);
    expect(max, `max IPC RTT ${max.toFixed(1)}ms at ${scale.name}`).toBeLessThanOrEqual(scale.ipcMaxBudgetMs);
  });
}

test('aged launching slots free capacity for a ready root', async ({ page }) => {
  test.setTimeout(180_000);
  const maxConcurrency = await page.evaluate(async () => (await window.invoker.getQueueStatus()).maxConcurrency);
  const workflowCount = Math.max(2, maxConcurrency);
  await page.evaluate(async (options) => {
    if (!window.invoker.seedStressFixture) {
      throw new Error('seedStressFixture is not exposed (NODE_ENV=test required)');
    }
    return window.invoker.seedStressFixture(options);
  }, {
    workflowCount,
    tasksPerWorkflow: 4,
    stuckLaunchingSlots: maxConcurrency,
    launchAgeMs: STUCK_LAUNCH_AGE_MS,
    nowIso: '2026-07-01T00:20:00.000Z',
  });
  await page.evaluate(async () => {
    const result = await window.invoker.getTasks();
    const tasks = Array.isArray(result) ? result : result.tasks;
    const updates = tasks
      .filter((task: any) => task.id.endsWith('/t0'))
      .map((task: any) => ({
        taskId: task.id,
        changes: {
          status: 'failed',
          execution: {
            phase: 'executing',
            completedAt: new Date(),
            error: 'clear running slot',
            exitCode: 1,
          },
        },
      }));
    if (!window.invoker.injectTaskStates) {
      throw new Error('injectTaskStates is not exposed (NODE_ENV=test required)');
    }
    await window.invoker.injectTaskStates(updates);
  });

  await loadPlan(page, buildReadyRootPlan());
  await startPlan(page);

  const rootTaskId = await page.evaluate(async () => {
    const workflows = await window.invoker.listWorkflows();
    const rootWorkflow = workflows.find((workflow) => workflow.name === 'Stress Ready Root');
    if (!rootWorkflow) throw new Error('Root workflow missing');
    const result = await window.invoker.getTasks();
    const tasks = Array.isArray(result) ? result : result.tasks;
    const rootTask = tasks.find((task: any) => task.config?.workflowId === rootWorkflow.id && task.description === 'Ready root');
    if (!rootTask) throw new Error('Root task missing');
    return rootTask.id as string;
  });

  await expect.poll(async () => {
    await page.evaluate(() => window.invoker.start());
    const status = await sampleQueueStatus(page);
    return {
      runningIds: status.running.map((task: { taskId: string }) => task.taskId),
      queuedIds: status.queued.map((task: { taskId: string }) => task.taskId),
    };
  }, { timeout: 15_000 }).toMatchObject({
    runningIds: expect.arrayContaining([rootTaskId]),
  });

  const queueStatus = await sampleQueueStatus(page);
  expect(queueStatus.queued.map((task: { taskId: string }) => task.taskId)).not.toContain(rootTaskId);
});
