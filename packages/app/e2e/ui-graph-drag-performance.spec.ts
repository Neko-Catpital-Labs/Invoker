import { expect, test, E2E_REPO_URL } from './fixtures/electron-app.js';
import { stringify as yamlStringify } from 'yaml';
import type { Page } from '@playwright/test';
import {
  activityLogWatermark,
  maxPayloadNumber,
  numberOrZero,
  uiPerfPayloadsSince,
  type UiPerfPayload,
} from './fixtures/ui-perf.js';

const WORKFLOW_COUNT = 50;
const TASKS_PER_WORKFLOW = 8;
const DRAG_STEPS = 60;
const DRAG_STEP_DELAY_MS = 16;
const RECORDING_DURATION_MS = 1_400;
const UPDATE_BURSTS = 12;
const UPDATES_PER_BURST = 24;
const UPDATE_BURST_DELAY_MS = 40;
const MIN_FRAME_COUNT = 35;
const MAX_P95_FRAME_GAP_MS = 80;
const MAX_FRAME_GAP_MS = 250;
const MIN_TRANSFORM_CHANGES = 12;
const MAX_FIRST_TRANSFORM_MS = 250;
const MAX_RENDERER_EVENT_LOOP_LAG_MS = 1000;
const MAX_RENDERER_LONG_TASK_MS = 1500;
const MAX_TASK_DELTA_BATCH_SIZE = 250;

const DRAG_PERF_BUDGETS = {
  minFrameCount: MIN_FRAME_COUNT,
  maxP95FrameGapMs: MAX_P95_FRAME_GAP_MS,
  maxFrameGapMs: MAX_FRAME_GAP_MS,
  minTransformChanges: MIN_TRANSFORM_CHANGES,
  maxFirstTransformMs: MAX_FIRST_TRANSFORM_MS,
  maxRendererEventLoopLagMs: MAX_RENDERER_EVENT_LOOP_LAG_MS,
  maxRendererLongTaskMs: MAX_RENDERER_LONG_TASK_MS,
  maxTaskDeltaBatchSize: MAX_TASK_DELTA_BATCH_SIZE,
};

interface DragPerfResult {
  frameCount: number;
  maxFrameGapMs: number;
  p95FrameGapMs: number;
  transformChanges: number;
  transformChanged: boolean;
  firstTransformMs: number | null;
  durationMs: number;
}

declare global {
  interface Window {
    __invokerDragPerf?: {
      done: boolean;
      startedAt: number;
      finishedAt: number;
      frames: number[];
      transforms: string[];
    };
  }
}

function buildPlan(index: number) {
  return {
    name: `UI Drag Perf Plan ${index}`,
    repoUrl: E2E_REPO_URL,
    onFinish: 'none' as const,
    tasks: Array.from({ length: TASKS_PER_WORKFLOW }, (_, taskIndex) => ({
      id: `task-${index}-${taskIndex}`,
      description: `Task ${index}-${taskIndex}`,
      command: `echo task-${index}-${taskIndex}`,
      dependencies: taskIndex === 0 ? [] : [`task-${index}-${taskIndex - 1}`],
    })),
  };
}


async function seedLargeWorkflowGraph(page: Page): Promise<void> {
  const plans = Array.from({ length: WORKFLOW_COUNT }, (_, index) => yamlStringify(buildPlan(index)));
  await page.evaluate(async (planTexts) => {
    for (const planText of planTexts) {
      await window.invoker.loadPlan(planText);
    }
  }, plans);
  await page.waitForFunction(
    (expected) => window.invoker.listWorkflows().then((workflows) => workflows.length >= expected),
    WORKFLOW_COUNT,
    { timeout: 30_000 },
  );
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click();
  }
  await page.getByTestId('sidebar-planning').click({ force: true });
  await page.getByRole('heading', { name: 'Plan graph' }).waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.locator('[data-testid^="workflow-node-"]:visible').first().waitFor({ state: 'visible', timeout: 15_000 });
}

async function recordDragPerformance(
  page: Page,
  paneSelector: string,
  viewportSelector: string,
  duringDrag?: () => Promise<unknown>,
): Promise<DragPerfResult> {
  await page.evaluate(({ durationMs, viewportSelector: selector }) => {
    const viewport = document.querySelector(selector) as HTMLElement | null;
    if (!viewport) throw new Error(`Missing viewport: ${selector}`);
    const state = {
      done: false,
      startedAt: performance.now(),
      finishedAt: 0,
      frames: [] as number[],
      transforms: [] as string[],
    };
    window.__invokerDragPerf = state;

    const sample = (timestamp: number) => {
      state.frames.push(timestamp);
      state.transforms.push(getComputedStyle(viewport).transform);
      if (timestamp - state.startedAt >= durationMs) {
        state.done = true;
        state.finishedAt = timestamp;
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { durationMs: RECORDING_DURATION_MS, viewportSelector });

  const pane = page.locator(paneSelector).first();
  const box = await pane.boundingBox();
  if (!box) throw new Error(`Graph pane is not visible: ${paneSelector}`);

  const startX = box.x + box.width * 0.5;
  const startY = box.y + box.height * 0.5;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const updateWork = duringDrag?.() ?? Promise.resolve();
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    const progress = step / DRAG_STEPS;
    await page.mouse.move(startX + 360 * progress, startY + Math.sin(progress * Math.PI * 2) * 24);
    await page.waitForTimeout(DRAG_STEP_DELAY_MS);
  }
  await page.mouse.up();
  await updateWork;

  await page.waitForFunction(() => window.__invokerDragPerf?.done === true, null, { timeout: RECORDING_DURATION_MS + 2_000 });

  return page.evaluate(() => {
    const state = window.__invokerDragPerf;
    if (!state) throw new Error('Missing drag performance samples');
    const gaps: number[] = [];
    for (let i = 1; i < state.frames.length; i += 1) {
      gaps.push(state.frames[i] - state.frames[i - 1]);
    }
    let transformChanges = 0;
    let firstTransformMs: number | null = null;
    for (let i = 1; i < state.transforms.length; i += 1) {
      if (state.transforms[i] !== state.transforms[i - 1]) {
        transformChanges += 1;
        firstTransformMs ??= state.frames[i] - state.startedAt;
      }
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const p95Index = sorted.length === 0 ? 0 : Math.ceil(sorted.length * 0.95) - 1;
    return {
      frameCount: state.frames.length,
      maxFrameGapMs: Math.max(0, ...gaps),
      p95FrameGapMs: sorted[p95Index] ?? 0,
      transformChanges,
      transformChanged: new Set(state.transforms).size > 1,
      firstTransformMs,
      durationMs: state.finishedAt - state.startedAt,
    };
  });
}

async function streamTaskUpdatesDuringDrag(page: Page): Promise<number> {
  const taskIds = await page.evaluate(async () => {
    const result = await window.invoker.getTasks();
    const tasks = Array.isArray(result) ? result : result.tasks;
    return tasks.map((task: { id: string }) => task.id);
  });
  let updateCount = 0;
  const statuses = ['running', 'completed', 'failed', 'pending'] as const;

  for (let burst = 0; burst < UPDATE_BURSTS; burst += 1) {
    const updates = Array.from({ length: UPDATES_PER_BURST }, (_, offset) => {
      const taskId = taskIds[(burst * UPDATES_PER_BURST + offset) % taskIds.length];
      const status = statuses[(burst + offset) % statuses.length];
      const now = new Date();
      return {
        taskId,
        changes: {
          status,
          execution: {
            startedAt: now,
            completedAt: status === 'completed' || status === 'failed' ? now : undefined,
            exitCode: status === 'completed' ? 0 : status === 'failed' ? 1 : undefined,
            error: status === 'failed' ? `drag update burst ${burst}` : undefined,
          },
        },
      };
    });
    await page.evaluate((burstUpdates) => window.invoker.injectTaskStates!(burstUpdates), updates);
    updateCount += updates.length;
    await page.waitForTimeout(UPDATE_BURST_DELAY_MS);
  }

  return updateCount;
}

function expectSmoothDrag(
  result: DragPerfResult,
  perf: Record<string, unknown>,
  perfPayloads: readonly UiPerfPayload[],
): void {
  const evidence = JSON.stringify({ ...result, perf, perfPayloads, budgets: DRAG_PERF_BUDGETS });
  expect(result.frameCount, evidence).toBeGreaterThanOrEqual(MIN_FRAME_COUNT);
  expect(result.p95FrameGapMs, evidence).toBeLessThanOrEqual(MAX_P95_FRAME_GAP_MS);
  expect(result.maxFrameGapMs, evidence).toBeLessThanOrEqual(MAX_FRAME_GAP_MS);
  expect(result.transformChanged, evidence).toBe(true);
  expect(result.transformChanges, evidence).toBeGreaterThanOrEqual(MIN_TRANSFORM_CHANGES);
  expect(result.firstTransformMs ?? Number.POSITIVE_INFINITY, evidence).toBeLessThanOrEqual(MAX_FIRST_TRANSFORM_MS);
  expect(numberOrZero(perf.maxRendererEventLoopLagMs), evidence).toBeLessThanOrEqual(MAX_RENDERER_EVENT_LOOP_LAG_MS);
  expect(numberOrZero(perf.maxRendererLongTaskMs), evidence).toBeLessThanOrEqual(MAX_RENDERER_LONG_TASK_MS);
  expect(maxPayloadNumber(perfPayloads, 'renderer_event_loop_lag', 'lagMs'), evidence).toBeLessThanOrEqual(MAX_RENDERER_EVENT_LOOP_LAG_MS);
  expect(maxPayloadNumber(perfPayloads, 'renderer_long_task', 'durationMs'), evidence).toBeLessThanOrEqual(MAX_RENDERER_LONG_TASK_MS);
  expect(numberOrZero(perf.maxTaskDeltaBatchSize), evidence).toBeLessThanOrEqual(MAX_TASK_DELTA_BATCH_SIZE);
}

test('workflow graph pan stays responsive under a large persisted graph', async ({ page }) => {
  await seedLargeWorkflowGraph(page);

  const perfWatermark = await activityLogWatermark(page);
  const result = await recordDragPerformance(
    page,
    '[data-testid="workflow-graph-react-flow"] .react-flow__pane',
    '[data-testid="workflow-graph-react-flow"] .react-flow__viewport',
  );
  const perfPayloads = await uiPerfPayloadsSince(page, perfWatermark);
  const perf = await page.evaluate(async () => await window.invoker.getUiPerfStats());

  console.log(`UI_GRAPH_DRAG_BENCH_RESULT=${JSON.stringify({
    ...result,
    workflowCount: WORKFLOW_COUNT,
    taskCount: WORKFLOW_COUNT * TASKS_PER_WORKFLOW,
    perfPayloads,
    perf,
    budgets: DRAG_PERF_BUDGETS,
  })}`);
  expectSmoothDrag(result, perf, perfPayloads);
});

test('workflow graph pan stays responsive while task updates arrive', async ({ page }) => {
  await seedLargeWorkflowGraph(page);

  let updateCount = 0;
  const perfWatermark = await activityLogWatermark(page);
  const result = await recordDragPerformance(
    page,
    '[data-testid="workflow-graph-react-flow"] .react-flow__pane',
    '[data-testid="workflow-graph-react-flow"] .react-flow__viewport',
    async () => {
      updateCount = await streamTaskUpdatesDuringDrag(page);
    },
  );
  const perfPayloads = await uiPerfPayloadsSince(page, perfWatermark);
  const perf = await page.evaluate(async () => await window.invoker.getUiPerfStats());

  console.log(`UI_GRAPH_DRAG_WITH_UPDATES_BENCH_RESULT=${JSON.stringify({
    ...result,
    workflowCount: WORKFLOW_COUNT,
    taskCount: WORKFLOW_COUNT * TASKS_PER_WORKFLOW,
    updateCount,
    updateBursts: UPDATE_BURSTS,
    updatesPerBurst: UPDATES_PER_BURST,
    perfPayloads,
    perf,
    budgets: DRAG_PERF_BUDGETS,
  })}`);
  const evidence = JSON.stringify({ ...result, updateCount, perfPayloads, perf, budgets: DRAG_PERF_BUDGETS });
  expect(updateCount, evidence).toBe(UPDATE_BURSTS * UPDATES_PER_BURST);
  expectSmoothDrag(result, perf, perfPayloads);
});
