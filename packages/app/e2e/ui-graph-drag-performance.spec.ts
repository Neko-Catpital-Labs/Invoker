import { expect, test, E2E_REPO_URL } from './fixtures/electron-app.js';
import { stringify as yamlStringify } from 'yaml';
import type { Page } from '@playwright/test';

const WORKFLOW_COUNT = 50;
const TASKS_PER_WORKFLOW = 8;
const DRAG_STEPS = 60;
const DRAG_STEP_DELAY_MS = 16;
const RECORDING_DURATION_MS = 1_400;
const MIN_FRAME_COUNT = 35;
const MAX_P95_FRAME_GAP_MS = 80;
const MAX_FRAME_GAP_MS = 250;
const MIN_TRANSFORM_CHANGES = 12;

interface DragPerfResult {
  frameCount: number;
  maxFrameGapMs: number;
  p95FrameGapMs: number;
  transformChanges: number;
  transformChanged: boolean;
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
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.locator('[data-testid^="workflow-node-"]:visible').first().waitFor({ state: 'visible', timeout: 10_000 });
}

async function recordDragPerformance(page: Page, paneSelector: string, viewportSelector: string): Promise<DragPerfResult> {
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
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    const progress = step / DRAG_STEPS;
    await page.mouse.move(startX + 360 * progress, startY + Math.sin(progress * Math.PI * 2) * 24);
    await page.waitForTimeout(DRAG_STEP_DELAY_MS);
  }
  await page.mouse.up();

  await page.waitForFunction(() => window.__invokerDragPerf?.done === true, null, { timeout: RECORDING_DURATION_MS + 2_000 });

  return page.evaluate(() => {
    const state = window.__invokerDragPerf;
    if (!state) throw new Error('Missing drag performance samples');
    const gaps: number[] = [];
    for (let i = 1; i < state.frames.length; i += 1) {
      gaps.push(state.frames[i] - state.frames[i - 1]);
    }
    let transformChanges = 0;
    for (let i = 1; i < state.transforms.length; i += 1) {
      if (state.transforms[i] !== state.transforms[i - 1]) transformChanges += 1;
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const p95Index = sorted.length === 0 ? 0 : Math.ceil(sorted.length * 0.95) - 1;
    return {
      frameCount: state.frames.length,
      maxFrameGapMs: Math.max(0, ...gaps),
      p95FrameGapMs: sorted[p95Index] ?? 0,
      transformChanges,
      transformChanged: new Set(state.transforms).size > 1,
      durationMs: state.finishedAt - state.startedAt,
    };
  });
}

function expectSmoothDrag(result: DragPerfResult): void {
  expect(result.transformChanged, JSON.stringify(result)).toBe(true);
  expect(result.transformChanges, JSON.stringify(result)).toBeGreaterThanOrEqual(MIN_TRANSFORM_CHANGES);
  expect(result.frameCount, JSON.stringify(result)).toBeGreaterThanOrEqual(MIN_FRAME_COUNT);
  expect(result.p95FrameGapMs, JSON.stringify(result)).toBeLessThanOrEqual(MAX_P95_FRAME_GAP_MS);
  expect(result.maxFrameGapMs, JSON.stringify(result)).toBeLessThanOrEqual(MAX_FRAME_GAP_MS);
}

test('workflow graph pan stays responsive under a large persisted graph', async ({ page }) => {
  await seedLargeWorkflowGraph(page);

  const result = await recordDragPerformance(
    page,
    '[data-testid="workflow-graph-react-flow"] .react-flow__pane',
    '[data-testid="workflow-graph-react-flow"] .react-flow__viewport',
  );

  console.log(`UI_GRAPH_DRAG_BENCH_RESULT=${JSON.stringify({
    ...result,
    workflowCount: WORKFLOW_COUNT,
    taskCount: WORKFLOW_COUNT * TASKS_PER_WORKFLOW,
    thresholds: {
      minFrameCount: MIN_FRAME_COUNT,
      maxP95FrameGapMs: MAX_P95_FRAME_GAP_MS,
      maxFrameGapMs: MAX_FRAME_GAP_MS,
      minTransformChanges: MIN_TRANSFORM_CHANGES,
    },
  })}`);
  expectSmoothDrag(result);
});
