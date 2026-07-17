import { _electron as electron, expect, test } from '@playwright/test';
import { resolveRepoRoot } from '@invoker/contracts';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';
import type { Page } from '@playwright/test';

import { E2E_REPO_URL } from './fixtures/electron-app.js';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';
import {
  activityLogWatermark,
  maxPayloadNumber,
  numberOrZero,
  parseActivityPayload,
  uiPerfPayloadsSince,
} from './fixtures/ui-perf.js';

const repoRoot = resolveRepoRoot(__dirname);
const STARTUP_BUDGET_MS = 12000;
const PLANNING_PRESSURE_TURNS = 30;
const PLANNING_INPUT_HANDLER_BUDGET_MS = 50;
const PLANNING_INPUT_COMMIT_BUDGET_MS = 250;
const PLANNING_INPUT_FILL_WALL_BUDGET_MS = 1500;
const MAX_PLANNING_RENDERER_EVENT_LOOP_LAG_MS = 1000;
const MAX_PLANNING_RENDERER_LONG_TASK_MS = 1500;
const STARTUP_GRAPH_VISIBLE_AFTER_WINDOW_BUDGET_MS = 5000;
const MAX_STARTUP_RENDERER_EVENT_LOOP_LAG_MS = 1000;
const MAX_STARTUP_RENDERER_LONG_TASK_MS = 1500;
const MAX_PLANNING_RENDERER_LONG_TASK_COUNT = 0;

const STARTUP_NONEMPTY_BUDGETS = {
  maxStartupMs: STARTUP_BUDGET_MS,
  maxGraphVisibleAfterWindowMs: STARTUP_GRAPH_VISIBLE_AFTER_WINDOW_BUDGET_MS,
  maxRendererEventLoopLagMs: MAX_STARTUP_RENDERER_EVENT_LOOP_LAG_MS,
  maxRendererLongTaskMs: MAX_STARTUP_RENDERER_LONG_TASK_MS,
};

const PLANNING_PRESSURE_BUDGETS = {
  pressureTurns: PLANNING_PRESSURE_TURNS,
  maxInputHandlerMs: PLANNING_INPUT_HANDLER_BUDGET_MS,
  maxInputCommitMs: PLANNING_INPUT_COMMIT_BUDGET_MS,
  maxInputFillWallMs: PLANNING_INPUT_FILL_WALL_BUDGET_MS,
  maxRendererEventLoopLagMs: MAX_PLANNING_RENDERER_EVENT_LOOP_LAG_MS,
  maxRendererLongTaskMs: MAX_PLANNING_RENDERER_LONG_TASK_MS,
  maxRendererLongTaskCount: MAX_PLANNING_RENDERER_LONG_TASK_COUNT,
};

async function launchElectronApp(testDir: string, extraEnv?: Record<string, string>) {
  const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
  const stubDir = path.join(testDir, 'claude-stub');
  const markerRoot = path.join(testDir, 'e2e-markers');
  const configPath = path.join(testDir, 'e2e-config.json');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  const electronUserDataDir = path.join(testDir, 'electron-user-data');
  await fs.mkdir(stubDir, { recursive: true });
  await fs.mkdir(markerRoot, { recursive: true });
  await fs.mkdir(electronUserDataDir, { recursive: true });
  registerTrackedBrowserUserDataDir(electronUserDataDir);
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');
  try {
    await fs.symlink(claudeMarker, path.join(stubDir, 'claude'));
  } catch {
    // ignore symlink failures on restricted platforms
  }
  return electron.launch({
    args: [
      ...(process.platform === 'linux'
        ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
        : []),
      `--user-data-dir=${electronUserDataDir}`,
      path.resolve(__dirname, '..', 'dist', 'main.js'),
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
          INVOKER_TEST_WORKFLOW_IDS: '1',
      INVOKER_GUI_OWNER_MODE: process.env.INVOKER_E2E_GUI_OWNER_MODE ?? 'gui',
      INVOKER_DB_DIR: testDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_E2E_MARKER_ROOT: markerRoot,
      INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ...(extraEnv ?? {}),
      INVOKER_USER_DATA_DIR: electronUserDataDir,
    },
  });
}

function buildPlan(index: number) {
  return {
    name: `Startup Perf Plan ${index}`,
    repoUrl: E2E_REPO_URL,
    onFinish: 'none' as const,
    tasks: Array.from({ length: 7 }, (_, taskIndex) => ({
      id: `task-${index}-${taskIndex}`,
      description: `Task ${index}-${taskIndex}`,
      command: `echo task-${index}-${taskIndex}`,
      dependencies: taskIndex === 0 ? [] : [`task-${index}-${taskIndex - 1}`],
    })),
  };
}

function buildPlanningPressureReply(): string {
  return Array.from({ length: 60 }, (_, index) => (
    `planning pressure reply line ${String(index + 1).padStart(2, '0')} keeps realistic transcript output in the renderer.`
  )).join('\n');
}

async function waitForWorkflowGraphVisible(page: Page, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  await page.locator('[data-testid^="workflow-node-"]:visible').first().waitFor({
    state: 'visible',
    timeout: timeoutMs,
  });
  return Date.now() - startedAt;
}

async function dragGraphAndAssertViewportMoves(page: Page): Promise<void> {
  const viewport = page.locator('.react-flow__viewport').first();
  const pane = page.locator('.react-flow__pane').first();
  const before = await viewport.evaluate((el) => getComputedStyle(el).transform);
  const box = await pane.boundingBox();
  if (!box) {
    throw new Error('React Flow pane is not visible');
  }
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 + 140, box.y + box.height * 0.5, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const after = await viewport.evaluate((el) => getComputedStyle(el).transform);
  expect(typeof before).toBe('string');
  expect(typeof after).toBe('string');
}

test('non-empty persisted startup stays responsive and avoids initial db-poll replay flood', async () => {
  const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-startup-nonempty-'));
  const workflowCount = 30;
  const tasksPerWorkflow = 8;
  const expectedTaskCount = workflowCount * tasksPerWorkflow;
  try {
    const seedApp = await launchElectronApp(testDir);
    try {
      const page = await seedApp.firstWindow({ timeout: 5000 });
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 15_000 });

      for (let index = 0; index < workflowCount; index += 1) {
        const planYaml = yamlStringify(buildPlan(index));
        await page.evaluate(async (planText) => {
          await window.invoker.loadPlan(planText);
        }, planYaml);
      }

      const seeded = await page.evaluate(() => window.invoker.getTasks());
      const seededTasks = Array.isArray(seeded) ? seeded : seeded.tasks;
      expect(seededTasks.length).toBe(expectedTaskCount);
    } finally {
      await seedApp.close();
    }

    const startedAt = Date.now();
    const app = await launchElectronApp(testDir, {
      INVOKER_TEST_RESUME_PENDING_DELAY_MS: '15000',
    });
    try {
      const page = await app.firstWindow({ timeout: STARTUP_BUDGET_MS });
      const elapsedMs = Date.now() - startedAt;
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10_000 });

      await waitForWorkflowGraphVisible(page, 5000);
      await dragGraphAndAssertViewportMoves(page);

      const result = await page.evaluate(async () => {
        const tasksResult = await window.invoker.getTasks();
        const tasks = Array.isArray(tasksResult) ? tasksResult : tasksResult.tasks;
        const perf = await window.invoker.getUiPerfStats();
        const activityLogs = await window.invoker.getActivityLogs();
        return { taskCount: tasks.length, perf, activityLogs };
      });

      const startupEntries = result.activityLogs
        .filter((entry) => entry.source === 'startup-phase' || entry.source === 'ui-perf')
        .flatMap((entry) => {
          const payload = parseActivityPayload(entry.message);
          return payload ? [{ source: entry.source, payload }] : [];
        });
      const startupPerfPayloads = startupEntries.map((entry) => entry.payload);

      const windowShow = [...startupEntries]
        .reverse()
        .find((entry) => entry.source === 'startup-phase' && entry.payload?.phase === 'window.show')
        ?.payload;
      const graphVisible = startupEntries.find(
        (entry) =>
          entry.source === 'ui-perf'
          && entry.payload?.metric === 'startup_workflow_graph_visible'
          && entry.payload?.nodeCount === workflowCount,
      )?.payload;
      const taskGraphVisible = startupEntries.find(
        (entry) =>
          entry.source === 'ui-perf'
          && entry.payload?.metric === 'startup_graph_visible'
          && entry.payload?.nodeCount === tasksPerWorkflow,
      )?.payload;
      const backgroundHydration = startupEntries.find(
        (entry) =>
          entry.source === 'startup-phase'
          && typeof entry.payload?.phase === 'string'
          && entry.payload.phase.startsWith('background-hydration'),
      );
      const phaseNames = new Set(
        ((result.perf.startupPhaseDetails as Array<{ phase?: string }> | undefined) ?? [])
          .map((entry) => entry.phase)
          .filter(Boolean),
      );
      const graphVisibleAfterWindowMs = Number(graphVisible?.processElapsedMs) - Number(windowShow?.elapsedMs);
      const startupEvidence = {
        workflowCount,
        tasksPerWorkflow,
        expectedTaskCount,
        elapsedMs,
        graphVisibleAfterWindowMs,
        taskCount: result.taskCount,
        perf: result.perf,
        startupEntries,
        startupPerfPayloads,
        budgets: STARTUP_NONEMPTY_BUDGETS,
      };
      console.log(`STARTUP_NONEMPTY_BENCH_RESULT=${JSON.stringify(startupEvidence)}`);
      const startupEvidenceMessage = JSON.stringify(startupEvidence);

      expect(windowShow, startupEvidenceMessage).toBeTruthy();
      expect(graphVisible, startupEvidenceMessage).toBeTruthy();
      expect(taskGraphVisible, startupEvidenceMessage).toBeTruthy();
      expect(backgroundHydration, startupEvidenceMessage).toBeUndefined();
      expect(graphVisibleAfterWindowMs, startupEvidenceMessage).toBeLessThanOrEqual(STARTUP_GRAPH_VISIBLE_AFTER_WINDOW_BUDGET_MS);
      expect(Number(graphVisible?.nodeCount), startupEvidenceMessage).toBe(workflowCount);
      expect(Number(taskGraphVisible?.nodeCount), startupEvidenceMessage).toBe(tasksPerWorkflow);
      expect(elapsedMs, startupEvidenceMessage).toBeLessThanOrEqual(STARTUP_BUDGET_MS);
      expect(numberOrZero(result.perf.maxRendererEventLoopLagMs), startupEvidenceMessage).toBeLessThanOrEqual(MAX_STARTUP_RENDERER_EVENT_LOOP_LAG_MS);
      expect(numberOrZero(result.perf.maxRendererLongTaskMs), startupEvidenceMessage).toBeLessThanOrEqual(MAX_STARTUP_RENDERER_LONG_TASK_MS);
      expect(maxPayloadNumber(startupPerfPayloads, 'renderer_event_loop_lag', 'lagMs'), startupEvidenceMessage).toBeLessThanOrEqual(MAX_STARTUP_RENDERER_EVENT_LOOP_LAG_MS);
      expect(maxPayloadNumber(startupPerfPayloads, 'renderer_long_task', 'durationMs'), startupEvidenceMessage).toBeLessThanOrEqual(MAX_STARTUP_RENDERER_LONG_TASK_MS);
      expect([...phaseNames], startupEvidenceMessage).toEqual(expect.arrayContaining([
        'listWorkflowsByStartupRecency',
        'orchestrator.restore.full-snapshot',
        'sqlite.workflow-metadata.query',
        'sqlite.tasks.query',
        'sqlite.workflow-rollups.compute',
        'sqlite.tasks.deserialize-reconcile',
        'bootstrap-ipc.serialize-return',
      ]));

      expect(result.taskCount, startupEvidenceMessage).toBe(expectedTaskCount);
      expect(result.perf.dbPollCreated, startupEvidenceMessage).toBe(0);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('planning chat typing stays responsive with a large restored transcript', async () => {
  const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-planning-chat-pressure-'));
  try {
    const app = await launchElectronApp(testDir, {
      INVOKER_TEST_RESUME_PENDING_DELAY_MS: '15000',
    });
    try {
      const page = await app.firstWindow({ timeout: STARTUP_BUDGET_MS });
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10_000 });
      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });

      const planYaml = yamlStringify(buildPlan(901));
      await page.evaluate(async ({ yaml, reply }) => {
        await window.invoker.setTestPlanningChatResponse?.({
          planYaml: yaml,
          planName: 'Planning Pressure Plan',
          reply,
        });
      }, { yaml: planYaml, reply: buildPlanningPressureReply() });

      let sessionId: string | undefined;
      for (let index = 0; index < PLANNING_PRESSURE_TURNS; index += 1) {
        const response = await page.evaluate(async ({ currentSessionId, message }) => {
          return window.invoker.planningChatSend({
            ...(currentSessionId ? { sessionId: currentSessionId } : {}),
            message,
            presetKey: 'codex',
          });
        }, {
          currentSessionId: sessionId,
          message: `pressure request ${index + 1}`,
        });
        expect(response.ok).toBe(true);
        if (!response.ok) throw new Error(response.error);
        sessionId = response.sessionId;
      }
      expect(sessionId).toBeTruthy();

      await page.reload();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10_000 });
      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-transcript')).toContainText(
        `pressure request ${PLANNING_PRESSURE_TURNS}`,
        { timeout: 10000 },
      );
      await expect
        .poll(async () => {
          const payloads = await uiPerfPayloadsSince(page, 0);
          return payloads.some((payload) =>
            payload.metric === 'planning_chat_transcript_commit'
            && Number(payload.lineCount) >= PLANNING_PRESSURE_TURNS * 2,
          );
        }, { timeout: 5000 })
        .toBe(true);

      const watermark = await activityLogWatermark(page);
      const typedText = 'keep typing responsive while the transcript is large';
      const fillStartedAt = Date.now();
      await page.getByTestId('invoker-terminal-input').fill(typedText);
      await expect(page.getByTestId('invoker-terminal-input')).toHaveValue(typedText);
      const fillWallMs = Date.now() - fillStartedAt;

      await expect
        .poll(async () => {
          const payloads = await uiPerfPayloadsSince(page, watermark);
          return payloads.some((payload) =>
            payload.metric === 'planning_chat_input_commit'
            && payload.valueLength === typedText.length
            && Number(payload.transcriptLineCount) >= PLANNING_PRESSURE_TURNS * 2,
          );
        }, { timeout: 5000 })
        .toBe(true);

      const payloads = await uiPerfPayloadsSince(page, watermark);
      const inputChange = payloads.find((payload) => payload.metric === 'planning_chat_input_change' && payload.valueLength === typedText.length);
      const inputCommit = payloads.find((payload) => payload.metric === 'planning_chat_input_commit' && payload.valueLength === typedText.length);
      const perf = await page.evaluate(async () => window.invoker.getUiPerfStats());
      const transcriptCommitPayloads = payloads.filter((payload) => payload.metric === 'planning_chat_transcript_commit');
      const eventLoopLagPayloads = payloads.filter((payload) => payload.metric === 'renderer_event_loop_lag');
      const longTaskPayloads = payloads.filter((payload) => payload.metric === 'renderer_long_task');
      const planningEvidence = {
        pressureTurns: PLANNING_PRESSURE_TURNS,
        typedLength: typedText.length,
        fillWallMs,
        inputChange,
        inputCommit,
        transcriptCommitPayloads,
        eventLoopLagPayloads,
        longTaskPayloads,
        perf,
        budgets: PLANNING_PRESSURE_BUDGETS,
      };
      console.log(`PLANNING_CHAT_PRESSURE_BENCH_RESULT=${JSON.stringify(planningEvidence)}`);
      const planningEvidenceMessage = JSON.stringify(planningEvidence);

      expect(inputChange, planningEvidenceMessage).toBeTruthy();
      expect(inputCommit, planningEvidenceMessage).toBeTruthy();
      expect(Number(inputChange?.handlerDurationMs), planningEvidenceMessage).toBeLessThanOrEqual(PLANNING_INPUT_HANDLER_BUDGET_MS);
      expect(Number(inputCommit?.durationMs), planningEvidenceMessage).toBeLessThanOrEqual(PLANNING_INPUT_COMMIT_BUDGET_MS);
      expect(Number(inputCommit?.transcriptLineCount), planningEvidenceMessage).toBeGreaterThanOrEqual(PLANNING_PRESSURE_TURNS * 2);
      expect(fillWallMs, planningEvidenceMessage).toBeLessThanOrEqual(PLANNING_INPUT_FILL_WALL_BUDGET_MS);
      expect(transcriptCommitPayloads.length, planningEvidenceMessage).toBe(0);
      expect(longTaskPayloads.length, planningEvidenceMessage).toBeLessThanOrEqual(MAX_PLANNING_RENDERER_LONG_TASK_COUNT);

      expect(Number(perf.planningChatInputChangeReports), planningEvidenceMessage).toBeGreaterThanOrEqual(1);
      expect(Number(perf.planningChatInputCommitReports), planningEvidenceMessage).toBeGreaterThanOrEqual(1);
      expect(Number(perf.maxPlanningChatInputHandlerMs), planningEvidenceMessage).toBeLessThanOrEqual(PLANNING_INPUT_HANDLER_BUDGET_MS);
      expect(Number(perf.maxPlanningChatInputCommitMs), planningEvidenceMessage).toBeLessThanOrEqual(PLANNING_INPUT_COMMIT_BUDGET_MS);
      expect(Number(perf.maxPlanningChatTranscriptLines), planningEvidenceMessage).toBeGreaterThanOrEqual(PLANNING_PRESSURE_TURNS * 2);
      expect(numberOrZero(perf.maxRendererEventLoopLagMs), planningEvidenceMessage).toBeLessThanOrEqual(MAX_PLANNING_RENDERER_EVENT_LOOP_LAG_MS);
      expect(numberOrZero(perf.maxRendererLongTaskMs), planningEvidenceMessage).toBeLessThanOrEqual(MAX_PLANNING_RENDERER_LONG_TASK_MS);
      expect(maxPayloadNumber(payloads, 'renderer_event_loop_lag', 'lagMs'), planningEvidenceMessage).toBeLessThanOrEqual(MAX_PLANNING_RENDERER_EVENT_LOOP_LAG_MS);
      expect(maxPayloadNumber(payloads, 'renderer_long_task', 'durationMs'), planningEvidenceMessage).toBeLessThanOrEqual(MAX_PLANNING_RENDERER_LONG_TASK_MS);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
