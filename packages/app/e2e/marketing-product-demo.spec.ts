/**
 * Marketing product-demo capture for InvokerWebsite.
 *
 * Dense scrubbed fixture: ≥7 prompt-only workflows, two 3-deep stacks.
 * Product cards capture real UI motion via frame sequences.
 *
 * Usage:
 *   MARKETING_OUTPUT_DIR=... MARKETING_FRAME_DIR=... \
 *   pnpm --filter @invoker/app exec playwright test e2e/marketing-product-demo.spec.ts --workers=1
 */

import { expect, type Locator, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import {
  test,
  E2E_REPO_URL,
  injectTaskStates,
  waitForStableUI,
} from './fixtures/electron-app.js';

const OUTPUT_DIR = process.env.MARKETING_OUTPUT_DIR
  ?? path.resolve(__dirname, '..', 'e2e', 'marketing-demos');
const FRAME_DIR = process.env.MARKETING_FRAME_DIR
  ?? path.resolve(__dirname, '..', 'e2e', 'marketing-frames');

const VIEWPORT = { width: 1440, height: 900 };
const DEMO_REVIEW_URL = 'https://github.com/example/checkout/pull/42';

type DenseWorld = {
  stackA: { root: string; mid: string; leaf: string };
  stackB: { root: string; mid: string; leaf: string };
  regression: string;
  payments: string;
  observability: string;
};

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

function promptTask(id: string, description: string, prompt: string, dependencies: string[] = []) {
  return { id, description, prompt, dependencies };
}

function completedExec(opts: {
  startedAgo: number;
  completedAgo: number;
  branch?: string;
  commit?: string;
  agentName?: string;
  workspacePath?: string;
  reviewUrl?: string;
}) {
  return {
    startedAt: ago(opts.startedAgo),
    completedAt: ago(opts.completedAgo),
    exitCode: 0,
    branch: opts.branch ?? 'stack/checkout',
    commit: opts.commit ?? 'a7c3e91',
    agentName: opts.agentName ?? 'claude',
    lastHeartbeatAt: ago(opts.completedAgo),
    ...(opts.workspacePath ? { workspacePath: opts.workspacePath } : {}),
    ...(opts.reviewUrl ? { reviewUrl: opts.reviewUrl } : {}),
  };
}

function runningExec(opts: {
  startedAgo: number;
  branch?: string;
  agentName?: string;
  workspacePath?: string;
}) {
  return {
    startedAt: ago(opts.startedAgo),
    branch: opts.branch ?? 'stack/checkout-wip',
    agentName: opts.agentName ?? 'claude',
    lastHeartbeatAt: ago(5_000),
    phase: 'executing' as const,
    ...(opts.workspacePath ? { workspacePath: opts.workspacePath } : {}),
  };
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function setMarketingViewport(page: Page): Promise<void> {
  await page.setViewportSize(VIEWPORT);
}

async function savePng(page: Page, name: string): Promise<void> {
  await ensureDir(OUTPUT_DIR);
  await setMarketingViewport(page);
  await waitForStableUI(page);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${name}.png`),
    timeout: 60000,
  });
}

/** Visible cursor for marketing frames (Playwright mouse is invisible in screenshots). */
async function installMarketingCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const existing = document.getElementById('marketing-cursor');
    if (existing) return;
    const cursor = document.createElement('div');
    cursor.id = 'marketing-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    Object.assign(cursor.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '22px',
      height: '22px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transform: 'translate(-2px, -2px)',
      background:
        'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'%3E%3Cpath fill=\'%23f5f5f0\' stroke=\'%23111111\' stroke-width=\'1.2\' d=\'M4 3l1.2 16.5 4.2-4.1 3.6 7.2 2.2-1.1-3.7-7.3L20 10.2z\'/%3E%3C/svg%3E") center / contain no-repeat',
      filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.55))',
    });
    document.documentElement.appendChild(cursor);
  });
}

async function moveMarketingCursor(
  page: Page,
  x: number,
  y: number,
  opts?: { steps?: number; capture?: () => Promise<void>; captureEvery?: number },
): Promise<void> {
  await installMarketingCursor(page);
  const from = await page.evaluate(() => {
    const cursor = document.getElementById('marketing-cursor') as HTMLElement | null;
    if (!cursor) return { x: 40, y: 80 };
    return {
      x: Number.parseFloat(cursor.style.left || '40') || 40,
      y: Number.parseFloat(cursor.style.top || '80') || 80,
    };
  });
  const steps = Math.max(1, opts?.steps ?? 10);
  const captureEvery = opts?.captureEvery ?? Math.max(2, Math.floor(steps / 4));
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const cx = from.x + (x - from.x) * t;
    const cy = from.y + (y - from.y) * t;
    await page.mouse.move(cx, cy);
    await page.evaluate(({ cx, cy }) => {
      const cursor = document.getElementById('marketing-cursor') as HTMLElement | null;
      if (!cursor) return;
      cursor.style.left = `${cx}px`;
      cursor.style.top = `${cy}px`;
    }, { cx, cy });
    if (opts?.capture && (step === steps || step % captureEvery === 0)) {
      await opts.capture();
    }
  }
}

async function clickWithCursor(
  page: Page,
  locator: Locator,
  opts?: { button?: 'left' | 'right'; capture?: () => Promise<void> },
): Promise<void> {
  const target = locator.first();
  await expect(target).toBeVisible({ timeout: 10000 });
  const box = await target.boundingBox();
  if (!box) throw new Error('Click target has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await moveMarketingCursor(page, x, y, { steps: 14, capture: opts?.capture });
  await page.waitForTimeout(120);
  if (opts?.capture) await opts.capture();
  await page.mouse.click(x, y, { button: opts?.button ?? 'left' });
}

/** Capture a short motion sequence as numbered PNG frames for ffmpeg. */
async function withFrameCapture(
  page: Page,
  scene: string,
  run: (capture: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const dir = path.join(FRAME_DIR, scene);
  await fs.rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
  await installMarketingCursor(page);
  let frame = 0;
  const capture = async () => {
    await setMarketingViewport(page);
    await waitForStableUI(page);
    const name = `frame-${String(frame).padStart(3, '0')}.png`;
    frame += 1;
    await page.screenshot({ path: path.join(dir, name), timeout: 60000 });
  };
  await run(capture);
  // Brief settle frames; scripts/capture-marketing-demos.sh also applies
  // ffmpeg tpad=stop_duration=3 so Product hero clips hold the final state.
  const holdFrames = Number(process.env.MARKETING_END_HOLD_FRAMES ?? 2);
  for (let i = 0; i < holdFrames; i += 1) {
    await capture();
    await page.waitForTimeout(250);
  }
  // Always leave a poster still for the website.
  await savePng(page, scene);
  if (frame === 0) {
    await capture();
  }
}

async function loadPlanAndSelect(page: Page, plan: unknown): Promise<string> {
  const beforeIds = await page.evaluate(async () => {
    const workflows = await window.invoker.listWorkflows();
    return workflows.map((workflow: { id: string }) => workflow.id);
  });
  await page.evaluate((yaml) => window.invoker.loadPlan(yaml), yamlStringify(plan));
  const workflow = await page.evaluate(async (knownIds) => {
    const workflows = await window.invoker.listWorkflows();
    return workflows.find((candidate: { id: string }) => !knownIds.includes(candidate.id))
      ?? workflows[workflows.length - 1]
      ?? null;
  }, beforeIds);
  expect(workflow?.id).toBeTruthy();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(250);
  const node = page.getByTestId(`rf__node-${workflow!.id}`).first();
  await node.waitFor({ state: 'attached', timeout: 15000 });
  await node.click({ force: true }).catch(async () => {
    await node.dispatchEvent('click', { bubbles: true });
  });
  await page.getByTestId('selected-workflow-mini-dag').waitFor({ state: 'visible', timeout: 10000 });
  return workflow!.id;
}

async function refreshAndSelectWorkflow(page: Page, workflowId: string): Promise<void> {
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(250);
  await page.getByTestId(`rf__node-${workflowId}`).first().click({ force: true });
  await page.getByTestId('selected-workflow-mini-dag').waitFor({ state: 'visible', timeout: 10000 });
}

async function fitGraph(page: Page): Promise<void> {
  const fit = page.getByRole('button', { name: 'Fit View' }).first();
  if (await fit.isVisible({ timeout: 2000 }).catch(() => false)) {
    await fit.click();
    await page.waitForTimeout(250);
  }
}

async function expandMiniDag(page: Page): Promise<void> {
  const panel = page.getByTestId('selected-workflow-mini-dag');
  await expect(panel).toBeVisible({ timeout: 10000 });
  await panel.evaluate((element) => {
    const panelElement = element as HTMLElement;
    panelElement.style.left = '12px';
    panelElement.style.right = 'auto';
    panelElement.style.top = '12px';
    panelElement.style.width = '560px';
    panelElement.style.height = '400px';
    panelElement.style.display = 'block';
  });
}

async function hideMiniDag(page: Page): Promise<void> {
  const miniDag = page.getByTestId('selected-workflow-mini-dag');
  if (await miniDag.isVisible({ timeout: 800 }).catch(() => false)) {
    await miniDag.evaluate((element) => {
      (element as HTMLElement).style.display = 'none';
    });
  }
}

async function minimizeInspectorIfVisible(page: Page): Promise<void> {
  const minimize = page.getByRole('button', { name: 'Minimize inspector' });
  if (await minimize.isVisible({ timeout: 800 }).catch(() => false)) {
    await minimize.click();
  }
}

async function clickMiniDagTask(
  page: Page,
  taskIdSuffix: string,
  opts?: { capture?: () => Promise<void> },
): Promise<void> {
  const node = page
    .getByTestId('selected-workflow-mini-dag')
    .locator(`.react-flow__node[data-testid$="${taskIdSuffix}"]`)
    .or(page.locator(`[title$="${taskIdSuffix}"]`))
    .first();
  await clickWithCursor(page, node, { capture: opts?.capture });
  await page.waitForTimeout(350);
}

async function openContextMenu(page: Page, locator: Locator, opts?: { capture?: () => Promise<void> }) {
  const target = locator.first();
  await expect(target).toBeVisible({ timeout: 10000 });
  const box = await target.boundingBox();
  if (!box) throw new Error('Context menu target has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await moveMarketingCursor(page, x, y, { steps: 12, capture: opts?.capture });
  await page.waitForTimeout(120);
  await page.mouse.click(x, y, { button: 'right' });
  const menu = page.getByRole('menu');
  if (!(await menu.isVisible({ timeout: 3000 }).catch(() => false))) {
    await target.dispatchEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      clientX: x,
      clientY: y,
    });
  }
  await expect(menu).toBeVisible({ timeout: 10000 });
  return menu;
}

/** Load ≥7 prompt-only workflows including two 3-deep stacks. */
async function loadDenseWorld(page: Page): Promise<DenseWorld> {
  const stackARoot = await loadPlanAndSelect(page, {
    name: 'Checkout API',
    repoUrl: E2E_REPO_URL,
    onFinish: 'pull_request' as const,
    mergeMode: 'external_review' as const,
    baseBranch: 'main',
    tasks: [
      promptTask('design-contract', 'Design checkout API contract', 'Design the checkout session API contract and OpenAPI types.'),
      promptTask('review-contract', 'Review contract with stakeholders', 'Summarize breaking changes for the checkout contract review.', ['design-contract']),
    ],
  });

  const stackAMid = await loadPlanAndSelect(page, {
    name: 'Checkout handlers',
    repoUrl: E2E_REPO_URL,
    onFinish: 'pull_request' as const,
    mergeMode: 'external_review' as const,
    baseBranch: 'main',
    externalDependencies: [{ workflowId: stackARoot, gatePolicy: 'review_ready' as const }],
    tasks: [
      promptTask('implement-handlers', 'Implement payment handlers', 'Implement payment webhook handlers for checkout sessions.'),
      promptTask('handler-tests', 'Add handler unit tests', 'Add focused unit tests for payment webhook idempotency.', ['implement-handlers']),
    ],
  });

  const stackALeaf = await loadPlanAndSelect(page, {
    name: 'Checkout release',
    repoUrl: E2E_REPO_URL,
    onFinish: 'pull_request' as const,
    mergeMode: 'external_review' as const,
    baseBranch: 'main',
    externalDependencies: [{ workflowId: stackAMid, gatePolicy: 'review_ready' as const }],
    tasks: [
      promptTask('release-notes', 'Draft checkout release notes', 'Draft release notes for the checkout API rollout.'),
      promptTask('rollout-checklist', 'Prepare rollout checklist', 'Prepare a production rollout checklist for checkout.', ['release-notes']),
    ],
  });

  const stackBRoot = await loadPlanAndSelect(page, {
    name: 'Docs root',
    repoUrl: E2E_REPO_URL,
    onFinish: 'pull_request' as const,
    mergeMode: 'external_review' as const,
    baseBranch: 'main',
    tasks: [
      promptTask('docs-outline', 'Outline checkout docs', 'Outline the public checkout developer docs structure.'),
    ],
  });

  const stackBMid = await loadPlanAndSelect(page, {
    name: 'Docs sync',
    repoUrl: E2E_REPO_URL,
    onFinish: 'pull_request' as const,
    mergeMode: 'external_review' as const,
    baseBranch: 'main',
    externalDependencies: [{ workflowId: stackBRoot, gatePolicy: 'review_ready' as const }],
    tasks: [
      promptTask('docs-write', 'Write checkout guides', 'Write the checkout quickstart and webhook guides.'),
      promptTask('docs-examples', 'Add code examples', 'Add TypeScript examples for creating checkout sessions.', ['docs-write']),
    ],
  });

  const stackBLeaf = await loadPlanAndSelect(page, {
    name: 'Docs publish',
    repoUrl: E2E_REPO_URL,
    onFinish: 'pull_request' as const,
    mergeMode: 'external_review' as const,
    baseBranch: 'main',
    externalDependencies: [{ workflowId: stackBMid, gatePolicy: 'review_ready' as const }],
    tasks: [
      promptTask('docs-publish', 'Publish docs site', 'Publish the checkout docs site and verify deep links.'),
    ],
  });

  const regression = await loadPlanAndSelect(page, {
    name: 'Regression suite',
    repoUrl: E2E_REPO_URL,
    onFinish: 'none' as const,
    baseBranch: 'main',
    tasks: [
      promptTask('smoke', 'Run smoke scenarios', 'Author smoke scenarios for checkout happy path and failure modes.'),
      promptTask('payments', 'Run payments scenarios', 'Author payments regression scenarios for webhook retries.', ['smoke']),
    ],
  });

  const payments = await loadPlanAndSelect(page, {
    name: 'Payments smoke',
    repoUrl: E2E_REPO_URL,
    onFinish: 'none' as const,
    baseBranch: 'main',
    tasks: [
      {
        ...promptTask(
          'provider-sandbox',
          'Validate provider sandbox',
          'Validate payment provider sandbox credentials and webhook signing.',
        ),
        executionAgent: 'codex',
      },
    ],
  });

  const observability = await loadPlanAndSelect(page, {
    name: 'Observability',
    repoUrl: E2E_REPO_URL,
    onFinish: 'none' as const,
    baseBranch: 'main',
    tasks: [
      promptTask('metrics', 'Add checkout metrics', 'Add latency and error-rate metrics for checkout session creation.'),
      promptTask('alerts', 'Wire checkout alerts', 'Wire alerts for elevated checkout 5xx rates.', ['metrics']),
    ],
  });

  return {
    stackA: { root: stackARoot, mid: stackAMid, leaf: stackALeaf },
    stackB: { root: stackBRoot, mid: stackBMid, leaf: stackBLeaf },
    regression,
    payments,
    observability,
  };
}

/** Populate the dense world with mixed live statuses for control-plane shots. */
async function populateDenseStatuses(page: Page, world: DenseWorld, workspacePath?: string): Promise<void> {
  await injectTaskStates(page, [
    // Stack A — mid running, leaf pending
    {
      taskId: 'design-contract',
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 200_000,
          completedAgo: 160_000,
          branch: 'stack/checkout-api',
          commit: '111aaa1',
          workspacePath,
        }),
      },
    },
    {
      taskId: 'review-contract',
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 150_000,
          completedAgo: 120_000,
          branch: 'stack/checkout-api',
          commit: '222bbb2',
          reviewUrl: DEMO_REVIEW_URL,
          workspacePath,
        }),
      },
    },
    {
      taskId: `__merge__${world.stackA.root}`,
      changes: {
        status: 'review_ready',
        execution: {
          ...completedExec({
            startedAgo: 110_000,
            completedAgo: 100_000,
            branch: 'stack/checkout-api',
            commit: '333ccc3',
            reviewUrl: DEMO_REVIEW_URL,
          }),
          reviewStatus: 'open',
        },
      },
    },
    {
      taskId: 'implement-handlers',
      changes: {
        status: 'running',
        execution: runningExec({
          startedAgo: 40_000,
          branch: 'stack/checkout-handlers',
          agentName: 'claude',
          workspacePath,
        }),
      },
    },
    {
      taskId: 'handler-tests',
      changes: { status: 'pending' },
    },
    {
      taskId: 'release-notes',
      changes: { status: 'pending' },
    },
    {
      taskId: 'rollout-checklist',
      changes: { status: 'pending' },
    },
    // Stack B — mostly completed / review ready
    {
      taskId: 'docs-outline',
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 180_000,
          completedAgo: 150_000,
          branch: 'stack/docs-root',
          commit: '444ddd4',
          workspacePath,
        }),
      },
    },
    {
      taskId: `__merge__${world.stackB.root}`,
      changes: {
        status: 'review_ready',
        execution: {
          ...completedExec({
            startedAgo: 140_000,
            completedAgo: 130_000,
            branch: 'stack/docs-root',
            commit: '555eee5',
            reviewUrl: 'https://github.com/example/checkout/pull/41',
          }),
        },
      },
    },
    {
      taskId: 'docs-write',
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 120_000,
          completedAgo: 90_000,
          branch: 'stack/docs-sync',
          commit: '666fff6',
          workspacePath,
        }),
      },
    },
    {
      taskId: 'docs-examples',
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 85_000,
          completedAgo: 70_000,
          branch: 'stack/docs-sync',
          commit: '777aaa7',
          workspacePath,
        }),
      },
    },
    {
      taskId: `__merge__${world.stackB.mid}`,
      changes: {
        status: 'review_ready',
        execution: {
          ...completedExec({
            startedAgo: 65_000,
            completedAgo: 55_000,
            branch: 'stack/docs-sync',
            commit: '888bbb8',
            reviewUrl: 'https://github.com/example/checkout/pull/40',
          }),
        },
      },
    },
    {
      taskId: 'docs-publish',
      changes: {
        status: 'running',
        execution: runningExec({
          startedAgo: 20_000,
          branch: 'stack/docs-publish',
          agentName: 'codex',
          workspacePath,
        }),
      },
    },
    // Siblings
    {
      taskId: 'smoke',
      changes: {
        status: 'failed',
        execution: {
          startedAt: ago(90_000),
          completedAt: ago(80_000),
          exitCode: 1,
          branch: 'stack/regression',
          commit: '999ccc9',
          agentName: 'claude',
          error: 'Smoke scenario failed: checkout session returned 500',
          workspacePath,
        },
      },
    },
    {
      taskId: 'payments',
      changes: { status: 'blocked', execution: { blockedBy: 'smoke' } },
    },
    {
      taskId: 'provider-sandbox',
      changes: {
        status: 'needs_input',
        config: {
          runnerKind: 'worktree',
          executionAgent: 'codex',
        },
        execution: {
          startedAt: ago(50_000),
          branch: 'stack/payments-smoke',
          agentName: 'codex',
          lastAgentName: 'codex',
          workspacePath,
          inputPrompt: 'Provide payment provider sandbox credentials to continue.',
          error: 'Sandbox credentials missing — attach terminal or reply in Slack.',
        },
      },
    },
    {
      taskId: 'metrics',
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 100_000,
          completedAgo: 75_000,
          branch: 'stack/observability',
          commit: 'aaabbb1',
          workspacePath,
        }),
      },
    },
    {
      taskId: 'alerts',
      changes: {
        status: 'awaiting_approval',
        execution: {
          startedAt: ago(30_000),
          branch: 'stack/observability',
          commit: 'bbbccc2',
          agentName: 'claude',
          isFixingWithAI: true,
          pendingFixError: 'Proposed alert thresholds ready for approval',
          workspacePath,
        },
        config: { executionAgent: 'claude' },
      },
    },
  ]);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(350);
}

/** Mark Stack A fully completed/success for rebase demo. */
async function completeStackA(page: Page, world: DenseWorld, workspacePath?: string): Promise<void> {
  await injectTaskStates(page, [
    {
      taskId: 'design-contract',
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 300_000,
          completedAgo: 280_000,
          branch: 'stack/checkout-api',
          commit: 'c0ffee1',
          workspacePath,
        }),
      },
    },
    {
      taskId: 'review-contract',
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 270_000,
          completedAgo: 250_000,
          branch: 'stack/checkout-api',
          commit: 'c0ffee2',
          workspacePath,
        }),
      },
    },
    {
      taskId: `__merge__${world.stackA.root}`,
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 240_000,
          completedAgo: 230_000,
          branch: 'stack/checkout-api',
          commit: 'c0ffee3',
          reviewUrl: DEMO_REVIEW_URL,
        }),
      },
    },
    {
      taskId: 'implement-handlers',
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 220_000,
          completedAgo: 200_000,
          branch: 'stack/checkout-handlers',
          commit: 'c0ffee4',
          workspacePath,
        }),
      },
    },
    {
      taskId: 'handler-tests',
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 190_000,
          completedAgo: 170_000,
          branch: 'stack/checkout-handlers',
          commit: 'c0ffee5',
          workspacePath,
        }),
      },
    },
    {
      taskId: `__merge__${world.stackA.mid}`,
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 160_000,
          completedAgo: 150_000,
          branch: 'stack/checkout-handlers',
          commit: 'c0ffee6',
          reviewUrl: 'https://github.com/example/checkout/pull/43',
        }),
      },
    },
    {
      taskId: 'release-notes',
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 140_000,
          completedAgo: 120_000,
          branch: 'stack/checkout-release',
          commit: 'c0ffee7',
          workspacePath,
        }),
      },
    },
    {
      taskId: 'rollout-checklist',
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 110_000,
          completedAgo: 90_000,
          branch: 'stack/checkout-release',
          commit: 'c0ffee8',
          workspacePath,
        }),
      },
    },
    {
      taskId: `__merge__${world.stackA.leaf}`,
      changes: {
        status: 'completed',
        execution: completedExec({
          startedAgo: 80_000,
          completedAgo: 70_000,
          branch: 'stack/checkout-release',
          commit: 'c0ffee9',
          reviewUrl: 'https://github.com/example/checkout/pull/44',
        }),
      },
    },
  ]);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(350);
}

/** After rebase UI action, force visible cascade to pending for deterministic video. */
async function injectStackAPendingCascade(page: Page, world: DenseWorld): Promise<void> {
  await injectTaskStates(page, [
    {
      taskId: 'implement-handlers',
      changes: { status: 'pending', execution: { branch: 'stack/checkout-handlers' } },
    },
    {
      taskId: 'handler-tests',
      changes: { status: 'pending' },
    },
    {
      taskId: `__merge__${world.stackA.mid}`,
      changes: { status: 'pending' },
    },
    {
      taskId: 'release-notes',
      changes: { status: 'pending' },
    },
    {
      taskId: 'rollout-checklist',
      changes: { status: 'pending' },
    },
    {
      taskId: `__merge__${world.stackA.leaf}`,
      changes: { status: 'pending' },
    },
  ]);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(350);
}

const CLAUDE_STACKED_PLAN = {
  name: 'Payments reliability',
  repoUrl: E2E_REPO_URL,
  baseBranch: 'main',
  onFinish: 'pull_request' as const,
  mergeMode: 'external_review' as const,
  workflows: [
    {
      name: 'Payments contracts',
      featureBranch: 'plan/payments-contracts',
      tasks: [
        {
          id: 'define-payment-contracts',
          description: 'Define payment contracts',
          prompt: 'Define shared payment webhook contracts for checkout.',
          dependencies: [] as string[],
        },
        {
          id: 'verify-payment-contracts',
          description: 'Verify payment contracts',
          prompt: 'Verify payment contract fixtures and schema compatibility.',
          dependencies: ['define-payment-contracts'],
        },
      ],
    },
    {
      name: 'Payments handlers',
      featureBranch: 'plan/payments-handlers',
      tasks: [
        {
          id: 'build-payment-handlers',
          description: 'Build payment handlers',
          prompt: 'Implement payment webhook handlers with idempotency keys.',
          dependencies: [] as string[],
        },
        {
          id: 'verify-payment-handlers',
          description: 'Verify payment handlers',
          prompt: 'Add regression coverage for payment webhook retries.',
          dependencies: ['build-payment-handlers'],
        },
      ],
    },
    {
      name: 'Payments rollout',
      featureBranch: 'plan/payments-rollout',
      tasks: [
        {
          id: 'rollout-payments',
          description: 'Prepare payments rollout',
          prompt: 'Prepare the payments reliability rollout checklist and alerts.',
          dependencies: [] as string[],
        },
      ],
    },
  ],
};

test.describe('marketing product demos', () => {
  test.beforeEach(async ({ page }) => {
    await setMarketingViewport(page);
  });

  test('control-cloud-agents', async ({ page, testDir }) => {
    const workspacePath = path.join(testDir, 'marketing-control');
    await fs.mkdir(workspacePath, { recursive: true });
    const world = await loadDenseWorld(page);
    await populateDenseStatuses(page, world, workspacePath);
    await hideMiniDag(page);
    await minimizeInspectorIfVisible(page);
    await fitGraph(page);
    await page.waitForTimeout(400);
    await savePng(page, 'control-cloud-agents');
  });

  test('monitor-execution', async ({ page, testDir }) => {
    const workspacePath = path.join(testDir, 'marketing-monitor');
    await fs.mkdir(workspacePath, { recursive: true });
    const world = await loadDenseWorld(page);
    await populateDenseStatuses(page, world, workspacePath);
    await refreshAndSelectWorkflow(page, world.stackA.mid);
    await expandMiniDag(page);
    await clickMiniDagTask(page, 'implement-handlers');
    await expect(page.getByTestId('workflow-inspector-title')).toBeVisible();
    await savePng(page, 'monitor-execution');
  });

  test('review-work', async ({ page, testDir }) => {
    const workspacePath = path.join(testDir, 'marketing-review');
    await fs.mkdir(workspacePath, { recursive: true });
    const world = await loadDenseWorld(page);
    await populateDenseStatuses(page, world, workspacePath);
    await refreshAndSelectWorkflow(page, world.stackA.root);
    await expandMiniDag(page);
    await clickMiniDagTask(page, 'review-contract');
    await expect(page.getByTestId('workflow-inspector-title')).toBeVisible();
    await savePng(page, 'review-work');
  });

  test('intervene', async ({ page, testDir }) => {
    const workspacePath = path.join(testDir, 'marketing-intervene');
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, 'README.md'), '# Acme Checkout\n', 'utf8');
    await fs.mkdir(path.join(workspacePath, 'src', 'payments'), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, 'src', 'payments', 'webhook-signing.ts'),
      'export function verifyWebhookSignature(): boolean { return true; }\n',
      'utf8',
    );

    // Scrubbed Codex session on disk so open-terminal resumes a real agent session.
    const agentSessionId = 'codex-demo-payments-sandbox';
    const sessionDir = path.join(testDir, 'agent-sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `${agentSessionId}.jsonl`),
      [
        JSON.stringify({ type: 'thread.started', thread_id: agentSessionId }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'user_message',
            text: 'Validate payment provider sandbox credentials and webhook signing.',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Sandbox credentials look valid and webhook signing verifies.',
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const world = await loadDenseWorld(page);
    await populateDenseStatuses(page, world, workspacePath);
    await injectTaskStates(page, [
      {
        taskId: 'provider-sandbox',
        changes: {
          status: 'needs_input',
          config: {
            runnerKind: 'worktree',
            executionAgent: 'codex',
          },
          execution: {
            startedAt: ago(50_000),
            branch: 'stack/payments-smoke',
            workspacePath,
            agentSessionId,
            lastAgentSessionId: agentSessionId,
            agentName: 'codex',
            lastAgentName: 'codex',
            inputPrompt: 'Review Codex sandbox validation, then approve or reply.',
            error: 'Awaiting human review of Codex sandbox validation.',
          },
        },
      },
    ]);

    await refreshAndSelectWorkflow(page, world.payments);
    await expandMiniDag(page);

    const tasksResult = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(tasksResult) ? tasksResult : tasksResult.tasks;
    const task = tasks.find((candidate) => candidate.id.endsWith('/provider-sandbox'));
    const fullTaskId = task?.id;
    expect(fullTaskId).toBeTruthy();
    expect(task?.execution?.agentName).toBe('codex');
    expect(task?.execution?.agentSessionId).toBe(agentSessionId);

    const taskNode = page
      .getByTestId('selected-workflow-mini-dag')
      .locator('.react-flow__node[data-testid$="provider-sandbox"]')
      .first();
    await expect(taskNode).toBeVisible({ timeout: 10000 });
    const box = await taskNode.boundingBox();
    if (!box) throw new Error('provider-sandbox task node has no bounding box');

    await withFrameCapture(page, 'intervene', async (capture) => {
      await taskNode.locator('> div').dispatchEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      });

      await expect(page.getByTestId('terminal-drawer-body')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('terminal-session-command')).toContainText('codex', { timeout: 10000 });
      await expect(page.getByTestId('terminal-session-command')).toContainText(agentSessionId);

      const terminalPane = page.getByTestId(`terminal-pane-${fullTaskId}`);
      await expect(terminalPane).toBeVisible();
      // Real PTY Codex stub transcript from agent-sessions/<id>.jsonl — not a shared hardcoded script.
      await expect(terminalPane.getByText('Validate payment provider sandbox credentials and webhook signing.')).toBeVisible({ timeout: 15000 });
      await expect(terminalPane.getByText('Sandbox credentials look valid and webhook signing verifies.')).toBeVisible({ timeout: 5000 });
      await expect(terminalPane.getByText(`Codex session: ${agentSessionId}`)).toBeVisible({ timeout: 5000 });
      await expect(terminalPane.getByText('stdin is not a terminal')).toHaveCount(0);

      await capture();
      await page.waitForTimeout(900);
      await capture();
      await page.waitForTimeout(900);
      await capture();
    });
  });

  test('drive-with-ai', async ({ page }) => {
    // Demo-tab still/loop: Claude planning session ready to submit.
    const plannedYaml = yamlStringify(CLAUDE_STACKED_PLAN);
    await page.evaluate(async ({ planYaml, planName }) => {
      await window.invoker.setTestPlanningChatResponse({
        planYaml,
        planName,
        reply: 'I drafted a 3-workflow Payments reliability stack. Ready to submit to Invoker.',
      });
    }, { planYaml: plannedYaml, planName: 'Payments reliability' });

    await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('invoker-terminal-input').fill('Improve payments reliability for checkout webhooks');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('invoker-terminal-ready-bar')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(800);
    await savePng(page, 'drive-with-ai');
    await page.evaluate(async () => {
      await window.invoker.setTestPlanningChatResponse(null);
    });
  });

  test('workflow-drilldown', async ({ page, testDir }) => {
    // Dense Plan graph → select workflow → double-click a Completed task →
    // embedded terminal shows the agent session that produced that work.
    const workspacePath = path.join(testDir, 'marketing-drilldown');
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, 'README.md'), '# Acme Checkout\n', 'utf8');
    await fs.mkdir(path.join(workspacePath, 'src', 'api'), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, 'src', 'api', 'checkout-contract.ts'),
      'export type CheckoutSession = { id: string };\n',
      'utf8',
    );

    const agentSessionId = 'codex-demo-checkout-contract';
    const sessionDir = path.join(testDir, 'agent-sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `${agentSessionId}.jsonl`),
      [
        JSON.stringify({ type: 'thread.started', thread_id: agentSessionId }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'user_message',
            text: 'Design the checkout session API contract and OpenAPI types.',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Checkout session contract drafted with OpenAPI types.',
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const world = await loadDenseWorld(page);
    await populateDenseStatuses(page, world, workspacePath);
    await injectTaskStates(page, [
      {
        taskId: 'design-contract',
        changes: {
          status: 'completed',
          config: {
            runnerKind: 'worktree',
            executionAgent: 'codex',
          },
          execution: {
            ...completedExec({
              startedAgo: 200_000,
              completedAgo: 160_000,
              branch: 'stack/checkout-api',
              commit: '111aaa1',
              agentName: 'codex',
              workspacePath,
            }),
            agentSessionId,
            lastAgentSessionId: agentSessionId,
            lastAgentName: 'codex',
          },
        },
      },
    ]);

    await withFrameCapture(page, 'workflow-drilldown', async (capture) => {
      await hideMiniDag(page);
      await minimizeInspectorIfVisible(page);
      await fitGraph(page);
      await moveMarketingCursor(page, 720, 420, { steps: 10, capture });
      await capture();

      const rootNode = page.getByTestId(`rf__node-${world.stackA.root}`).first();
      await clickWithCursor(page, rootNode, { capture });
      await page.getByTestId('selected-workflow-mini-dag').waitFor({ state: 'visible', timeout: 10000 });
      await expandMiniDag(page);
      await capture();

      const tasksResult = await page.evaluate(() => window.invoker.getTasks());
      const tasks = Array.isArray(tasksResult) ? tasksResult : tasksResult.tasks;
      const task = tasks.find((candidate) => candidate.id.endsWith('/design-contract'));
      const fullTaskId = task?.id;
      expect(fullTaskId).toBeTruthy();
      expect(task?.status).toBe('completed');
      expect(task?.execution?.agentSessionId).toBe(agentSessionId);

      const taskNode = page
        .getByTestId('selected-workflow-mini-dag')
        .locator('.react-flow__node[data-testid$="design-contract"]')
        .first();
      await expect(taskNode).toBeVisible({ timeout: 10000 });
      const box = await taskNode.boundingBox();
      if (!box) throw new Error('design-contract task node has no bounding box');

      await moveMarketingCursor(page, box.x + box.width / 2, box.y + box.height / 2, {
        steps: 16,
        capture,
      });
      await capture();
      await taskNode.locator('> div').dispatchEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      });

      await expect(page.getByTestId('terminal-drawer-body')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('terminal-session-command')).toContainText('codex', { timeout: 10000 });
      await expect(page.getByTestId('terminal-session-command')).toContainText(agentSessionId);

      const terminalPane = page.getByTestId(`terminal-pane-${fullTaskId}`);
      await expect(terminalPane).toBeVisible();
      // Match this task's persisted Codex transcript (not another scene's hardcoded copy).
      await expect(terminalPane.getByText('Design the checkout session API contract and OpenAPI types.')).toBeVisible({ timeout: 15000 });
      await expect(terminalPane.getByText('Checkout session contract drafted with OpenAPI types.')).toBeVisible({ timeout: 5000 });
      await expect(terminalPane.getByText(`Codex session: ${agentSessionId}`)).toBeVisible({ timeout: 5000 });
      await expect(terminalPane.getByText('stdin is not a terminal')).toHaveCount(0);

      // Final beat: dense Plan graph + mini-DAG + open session drawer (no Full graph).
      await minimizeInspectorIfVisible(page);
      await expandMiniDag(page);
      await capture();
      await page.waitForTimeout(900);
      await capture();
      await page.waitForTimeout(900);
      await capture();
    });
  });

  test('rebase-intention', async ({ page, testDir }) => {
    const workspacePath = path.join(testDir, 'marketing-rebase');
    await fs.mkdir(workspacePath, { recursive: true });
    const world = await loadDenseWorld(page);
    await populateDenseStatuses(page, world, workspacePath);
    await completeStackA(page, world, workspacePath);

    await withFrameCapture(page, 'rebase-intention', async (capture) => {
      await hideMiniDag(page);
      await minimizeInspectorIfVisible(page);
      await fitGraph(page);
      await capture();
      await page.waitForTimeout(400);
      await capture();

      const rootNode = page.getByTestId(`rf__node-${world.stackA.root}`).first();
      await openContextMenu(page, rootNode);
      await capture();
      await page.getByRole('menuitem', { name: 'More' }).click();
      await expect(page.getByRole('menuitem', { name: 'Rebase and Recreate' })).toBeVisible();
      await capture();
      await page.getByRole('menuitem', { name: 'Rebase and Recreate' }).click();
      await capture();

      // Deterministic visual cascade even if executor work is async/heavy.
      await injectStackAPendingCascade(page, world);
      await hideMiniDag(page);
      await fitGraph(page);
      await capture();
      await page.waitForTimeout(500);
      await capture();
      await page.waitForTimeout(500);
      await capture();
    });
  });

  test('agent-driven-workflow', async ({ page, testDir }) => {
    // Primary: Claude session → Submit to Invoker → new chain appears.
    // Secondary: double-click a prompt task to open terminal.
    const workspacePath = path.join(testDir, 'marketing-agent');
    await fs.mkdir(workspacePath, { recursive: true });
    const world = await loadDenseWorld(page);
    await populateDenseStatuses(page, world, workspacePath);

    const plannedYaml = yamlStringify(CLAUDE_STACKED_PLAN);

    await withFrameCapture(page, 'agent-driven-workflow', async (capture) => {
      await page.evaluate(async ({ planYaml, planName }) => {
        await window.invoker.setTestPlanningChatResponse({
          planYaml,
          planName,
          reply: [
            'I inspected the checkout payments path and drafted a 3-workflow stack:',
            '1) Payments contracts',
            '2) Payments handlers',
            '3) Payments rollout',
            'Say the word and I will submit this to Invoker.',
          ].join('\n'),
        });
      }, { planYaml: plannedYaml, planName: 'Payments reliability' });

      await page.getByTestId('sidebar-planning').click().catch(() => undefined);
      await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
      await capture();

      await page.getByTestId('invoker-terminal-input').fill(
        'Claude: improve payments reliability and submit a stacked Invoker plan',
      );
      await capture();
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByTestId('invoker-terminal-ready-bar')).toBeVisible({ timeout: 15000 });
      await capture();
      await page.waitForTimeout(500);
      await capture();

      await page.getByRole('button', { name: 'Submit to Invoker' }).click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole('button', { name: /Payments contracts/ })).toBeVisible({ timeout: 15000 });
      await capture();
      await fitGraph(page);
      await capture();
      await page.waitForTimeout(500);
      await capture();

      // Secondary beat: open a task terminal on an existing prompt task.
      await refreshAndSelectWorkflow(page, world.stackA.mid);
      await expandMiniDag(page);
      const handlers = page.locator('[title$="implement-handlers"]').or(
        page.getByTestId('selected-workflow-mini-dag').locator('.react-flow__node[data-testid$="implement-handlers"]'),
      ).first();
      if (await handlers.isVisible({ timeout: 5000 }).catch(() => false)) {
        // Ensure workspace exists for terminal spawn.
        await injectTaskStates(page, [
          {
            taskId: 'implement-handlers',
            changes: {
              status: 'completed',
              execution: completedExec({
                startedAgo: 40_000,
                completedAgo: 20_000,
                branch: 'stack/checkout-handlers',
                workspacePath,
              }),
            },
          },
        ]);
        await page.getByRole('button', { name: 'Refresh' }).click();
        await page.waitForTimeout(250);
        await handlers.dispatchEvent('dblclick');
        await expect(page.getByTestId('terminal-drawer-body')).toBeVisible({ timeout: 10000 }).catch(() => undefined);
        await capture();
        await page.waitForTimeout(600);
        await capture();
      }

      await page.evaluate(async () => {
        await window.invoker.setTestPlanningChatResponse(null);
      });
    });
  });

  test('status-filtering', async ({ page, testDir }) => {
    const workspacePath = path.join(testDir, 'marketing-filter');
    await fs.mkdir(workspacePath, { recursive: true });
    const world = await loadDenseWorld(page);
    await populateDenseStatuses(page, world, workspacePath);

    await withFrameCapture(page, 'status-filtering', async (capture) => {
      await hideMiniDag(page);
      await minimizeInspectorIfVisible(page);
      await fitGraph(page);
      await capture();

      const clickPill = async (name: RegExp) => {
        const pill = page.getByRole('button', { name }).first();
        await expect(pill).toBeVisible({ timeout: 10000 });
        await pill.click();
        await page.waitForTimeout(700);
        await capture();
      };

      await clickPill(/running \(\d+\)/i);
      await clickPill(/failed \(\d+\)/i);
      await clickPill(/review ready \(\d+\)/i);
      await clickPill(/completed \(\d+\)/i);
      await clickPill(/awaiting approval \(\d+\)/i);
      await clickPill(/running \(\d+\)/i);
      await page.waitForTimeout(400);
      await capture();
    });
  });
});
