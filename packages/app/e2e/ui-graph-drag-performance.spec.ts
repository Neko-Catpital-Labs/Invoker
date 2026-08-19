import { expect, test } from './fixtures/electron-app.js';
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
const DRAG_DELTA_X = 360;
const DRAG_STEPS = 60;
const DRAG_STEP_DELAY_MS = 16;
const RECORDING_DURATION_MS = 1_400;
const RECORDING_DONE_TIMEOUT_MS = 15_000;
const UPDATE_BURSTS = 8;
const UPDATES_PER_BURST = 16;
const UPDATE_BURST_DELAY_MS = 50;
const UPDATE_START_DELAY_MS = 250;
const MIN_FRAME_COUNT = 35;
const MAX_P95_FRAME_GAP_MS = 80;
const MAX_P95_FRAME_GAP_WITH_UPDATES_MS = 220;
const MAX_FRAME_GAP_MS = 250;
const MIN_TRANSFORM_CHANGES = 12;
const MAX_FIRST_TRANSFORM_MS = 600;
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

const DRAG_PERF_BUDGETS_WITH_UPDATES = {
  ...DRAG_PERF_BUDGETS,
  maxP95FrameGapMs: MAX_P95_FRAME_GAP_WITH_UPDATES_MS,
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

interface DragStartPoint {
  x: number;
  y: number;
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
    __invokerDragUpdateState?: {
      done: boolean;
      updateCount: number;
      error?: string;
    };
  }
}

async function dismissKnownOverlays(page: Page): Promise<void> {
  // Re-query each iteration: dismissing one overlay shifts the remaining buttons.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const button = page.getByRole('button', { name: /^(Dismiss|Close|Skip for now|Not now)$/i }).first();
    if (!(await button.isVisible().catch(() => false))) {
      return;
    }
    await button.dispatchEvent('click', { bubbles: true, cancelable: true });
    await page.waitForTimeout(100);
  }
}

async function openPlanGraph(page: Page): Promise<void> {
  await dismissKnownOverlays(page);
  await page.getByTestId('sidebar-planning').dispatchEvent('click', { bubbles: true, cancelable: true });
  await page.getByRole('heading', { name: 'Plan graph' }).waitFor({ state: 'visible', timeout: 30_000 });
}

async function seedLargeWorkflowGraph(page: Page): Promise<void> {
  await page.evaluate(async (options) => {
    if (!window.invoker.seedStressFixture) {
      throw new Error('seedStressFixture is not exposed (NODE_ENV=test required)');
    }
    await window.invoker.seedStressFixture(options);
  }, {
    workflowCount: WORKFLOW_COUNT,
    tasksPerWorkflow: TASKS_PER_WORKFLOW,
    eventsPerTask: 0,
    taskStatusMode: 'completed',
  });
  await page.waitForFunction(
    (expected) => window.invoker.listWorkflows().then((workflows) => workflows.length >= expected),
    WORKFLOW_COUNT,
    { timeout: 30_000 },
  );
  await openPlanGraph(page);
  await dismissKnownOverlays(page);
  await page.getByRole('button', { name: 'Refresh' }).dispatchEvent('click', { bubbles: true, cancelable: true });
  await page.locator('[data-testid^="workflow-node-"]:visible').first().waitFor({ state: 'visible', timeout: 30_000 });
}

async function findPaneDragStart(page: Page, paneSelector: string): Promise<DragStartPoint> {
  return page.evaluate(({ selector, dragDeltaX }) => {
    const pane = document.querySelector(selector) as HTMLElement | null;
    if (!pane) throw new Error(`Missing graph pane: ${selector}`);

    const rect = pane.getBoundingClientRect();
    const minX = rect.left + 24;
    const maxX = Math.max(minX, rect.right - dragDeltaX - 24);
    const minY = rect.top + 24;
    const maxY = Math.max(minY, rect.bottom - 24);
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const xs = Array.from(new Set([
      minX,
      clamp(rect.left + rect.width * 0.15, minX, maxX),
      clamp(rect.left + rect.width * 0.3, minX, maxX),
      clamp(rect.left + rect.width * 0.5, minX, maxX),
      clamp(rect.left + rect.width * 0.7, minX, maxX),
      maxX,
    ]));
    const ys = Array.from(new Set([
      minY,
      clamp(rect.top + rect.height * 0.15, minY, maxY),
      clamp(rect.top + rect.height * 0.35, minY, maxY),
      clamp(rect.top + rect.height * 0.55, minY, maxY),
      clamp(rect.top + rect.height * 0.75, minY, maxY),
      maxY,
    ]));
    const blockedSelector = [
      '.react-flow__node',
      '[data-testid^="workflow-node-"]',
      '.react-flow__controls',
      'a',
      'button',
      'input',
      'textarea',
      'select',
      '[contenteditable="true"]',
    ].join(',');

    for (const y of ys) {
      for (const x of xs) {
        const target = document.elementFromPoint(x, y);
        const targetElement = target instanceof Element ? target : null;
        if (!targetElement) continue;
        if (targetElement.closest(blockedSelector)) continue;
        if (!pane.contains(targetElement) && targetElement !== pane) continue;
        return { x, y };
      }
    }

    return {
      x: clamp(rect.left + rect.width * 0.5, minX, maxX),
      y: clamp(rect.top + rect.height * 0.5, minY, maxY),
    };
  }, { selector: paneSelector, dragDeltaX: DRAG_DELTA_X });
}

async function recordDragPerformance(
  page: Page,
  paneSelector: string,
  viewportSelector: string,
  startDuringDrag?: () => Promise<() => Promise<unknown>>,
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

  const { x: startX, y: startY } = await findPaneDragStart(page, paneSelector);
  if (
    startX < box.x ||
    startX > box.x + box.width ||
    startY < box.y ||
    startY > box.y + box.height
  ) {
    throw new Error(`Graph drag start is outside visible pane: ${JSON.stringify({ startX, startY, box })}`);
  }
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y) ?? window;
    target.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
      view: window,
    }));
  }, { x: startX, y: startY });
  const waitForUpdateWork = startDuringDrag ? await startDuringDrag() : async () => undefined;
  await page.evaluate(
    ({ startX: x, startY: y, dragDeltaX, dragSteps, dragStepDelayMs }) => {
      const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
      const dispatchMove = (clientX: number, clientY: number) => {
        window.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
          clientX,
          clientY,
          view: window,
        }));
      };
      const dispatchEnd = (clientX: number, clientY: number) => {
        window.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 0,
          clientX,
          clientY,
          view: window,
        }));
      };

      return (async () => {
        let lastX = x;
        let lastY = y;
        for (let step = 1; step <= dragSteps; step += 1) {
          const progress = step / dragSteps;
          lastX = x + dragDeltaX * progress;
          lastY = y + Math.sin(progress * Math.PI * 2) * 24;
          dispatchMove(lastX, lastY);
          await sleep(dragStepDelayMs);
        }
        dispatchEnd(lastX, lastY);
      })();
    },
    {
      startX,
      startY,
      dragDeltaX: DRAG_DELTA_X,
      dragSteps: DRAG_STEPS,
      dragStepDelayMs: DRAG_STEP_DELAY_MS,
    },
  );
  await waitForUpdateWork();

  await page.waitForFunction(() => window.__invokerDragPerf?.done === true, null, { timeout: RECORDING_DONE_TIMEOUT_MS });

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

async function startTaskUpdatesDuringDrag(page: Page): Promise<() => Promise<number>> {
  const taskIds = await page.evaluate(async () => {
    const result = await window.invoker.getTasks();
    const tasks = Array.isArray(result) ? result : result.tasks;
    return tasks.map((task: { id: string }) => task.id);
  });

  await page.evaluate(
    ({ taskIds: ids, updateBursts, updatesPerBurst, updateBurstDelayMs, updateStartDelayMs }) => {
      const state: NonNullable<Window['__invokerDragUpdateState']> = { done: false, updateCount: 0 };
      window.__invokerDragUpdateState = state;
      const statuses = ['running', 'completed', 'failed', 'pending'] as const;
      const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

      void (async () => {
        try {
          await sleep(updateStartDelayMs);
          for (let burst = 0; burst < updateBursts; burst += 1) {
            const updates = Array.from({ length: updatesPerBurst }, (_, offset) => {
              const taskId = ids[(burst * updatesPerBurst + offset) % ids.length];
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
            await window.invoker.injectTaskStates!(updates);
            state.updateCount += updates.length;
            await sleep(updateBurstDelayMs);
          }
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error);
        } finally {
          state.done = true;
        }
      })();
    },
    {
      taskIds,
      updateBursts: UPDATE_BURSTS,
      updatesPerBurst: UPDATES_PER_BURST,
      updateBurstDelayMs: UPDATE_BURST_DELAY_MS,
      updateStartDelayMs: UPDATE_START_DELAY_MS,
    },
  );

  return async () => {
    await page.waitForFunction(() => window.__invokerDragUpdateState?.done === true, null, { timeout: 30_000 });
    const state = await page.evaluate(() => window.__invokerDragUpdateState);
    if (!state) throw new Error('Missing drag update state');
    if (state.error) throw new Error(state.error);
    return state.updateCount;
  };
}

async function completeAllSeededTasks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const result = await window.invoker.getTasks();
    const tasks = Array.isArray(result) ? result : result.tasks;
    const completedAt = new Date();
    await window.invoker.injectTaskStates!(tasks.map((task: { id: string }) => ({
      taskId: task.id,
      changes: {
        status: 'completed',
        execution: {
          phase: undefined,
          completedAt,
          exitCode: 0,
          error: undefined,
          isFixingWithAI: false,
        },
      },
    })));
  });
}

function expectSmoothDrag(
  result: DragPerfResult,
  perf: Record<string, unknown>,
  perfPayloads: readonly UiPerfPayload[],
  budgets: typeof DRAG_PERF_BUDGETS = DRAG_PERF_BUDGETS,
): void {
  const evidence = JSON.stringify({ ...result, perf, perfPayloads, budgets });
  expect(result.frameCount, evidence).toBeGreaterThanOrEqual(budgets.minFrameCount);
  expect(result.p95FrameGapMs, evidence).toBeLessThanOrEqual(budgets.maxP95FrameGapMs);
  expect(result.maxFrameGapMs, evidence).toBeLessThanOrEqual(budgets.maxFrameGapMs);
  expect(result.transformChanged, evidence).toBe(true);
  expect(result.transformChanges, evidence).toBeGreaterThanOrEqual(budgets.minTransformChanges);
  expect(result.firstTransformMs ?? Number.POSITIVE_INFINITY, evidence).toBeLessThanOrEqual(budgets.maxFirstTransformMs);
  expect(numberOrZero(perf.maxRendererEventLoopLagMs), evidence).toBeLessThanOrEqual(budgets.maxRendererEventLoopLagMs);
  expect(numberOrZero(perf.maxRendererLongTaskMs), evidence).toBeLessThanOrEqual(budgets.maxRendererLongTaskMs);
  expect(maxPayloadNumber(perfPayloads, 'renderer_event_loop_lag', 'lagMs'), evidence).toBeLessThanOrEqual(budgets.maxRendererEventLoopLagMs);
  expect(maxPayloadNumber(perfPayloads, 'renderer_long_task', 'durationMs'), evidence).toBeLessThanOrEqual(budgets.maxRendererLongTaskMs);
  expect(numberOrZero(perf.maxTaskDeltaBatchSize), evidence).toBeLessThanOrEqual(budgets.maxTaskDeltaBatchSize);
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
  try {
    const perfWatermark = await activityLogWatermark(page);
    const result = await recordDragPerformance(
      page,
      '[data-testid="workflow-graph-react-flow"] .react-flow__pane',
      '[data-testid="workflow-graph-react-flow"] .react-flow__viewport',
      async () => {
        const waitForUpdates = await startTaskUpdatesDuringDrag(page);
        return async () => {
          updateCount = await waitForUpdates();
        };
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
      budgets: DRAG_PERF_BUDGETS_WITH_UPDATES,
    })}`);
    const evidence = JSON.stringify({ ...result, updateCount, perfPayloads, perf, budgets: DRAG_PERF_BUDGETS_WITH_UPDATES });
    expect(updateCount, evidence).toBe(UPDATE_BURSTS * UPDATES_PER_BURST);
    expectSmoothDrag(result, perf, perfPayloads, DRAG_PERF_BUDGETS_WITH_UPDATES);
  } finally {
    await completeAllSeededTasks(page).catch(() => {});
  }
});
