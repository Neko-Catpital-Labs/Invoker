import { _electron as electron, expect, test } from '@playwright/test';
import { resolveRepoRoot } from '@invoker/contracts';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';

import { E2E_REPO_URL } from './fixtures/electron-app.js';

const repoRoot = resolveRepoRoot(__dirname);
const TRANSCRIPT_MESSAGE_COUNT = 2_000;
const TRANSCRIPT_CONTENT_BYTES = 2_048;
const PLANNING_RESPONSE_DELAY_MS = 900;
const SAMPLE_DELAY_MS = 20;
const MIN_RTT_SAMPLES = 18;
const P95_RTT_BUDGET_MS = 150;
const MAX_RTT_BUDGET_MS = 750;

async function launchElectronApp(testDir: string) {
  const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
  const stubDir = path.join(testDir, 'claude-stub');
  const markerRoot = path.join(testDir, 'e2e-markers');
  const configPath = path.join(testDir, 'e2e-config.json');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  await fs.mkdir(stubDir, { recursive: true });
  await fs.mkdir(markerRoot, { recursive: true });
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
      path.resolve(__dirname, '..', 'dist', 'main.js'),
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TZ: 'UTC',
      INVOKER_DB_DIR: testDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_E2E_MARKER_ROOT: markerRoot,
      INVOKER_CLAUDE_COMMAND: claudeMarker,
      INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
      INVOKER_TEST_PLANNING_CHAT_RESPONSE: 'Planner deterministic e2e response.',
      INVOKER_TEST_PLANNING_CHAT_RESPONSE_DELAY_MS: String(PLANNING_RESPONSE_DELAY_MS),
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
}

function buildWorkflow(index: number) {
  return {
    name: `Planning Chat RTT Probe ${index}`,
    repoUrl: E2E_REPO_URL,
    onFinish: 'none' as const,
    tasks: Array.from({ length: 4 }, (_, taskIndex) => ({
      id: `probe-${index}-${taskIndex}`,
      description: `Probe task ${index}-${taskIndex}`,
      command: `echo probe-${index}-${taskIndex}`,
      dependencies: taskIndex === 0 ? [] : [`probe-${index}-${taskIndex - 1}`],
    })),
  };
}

function percentile(values: number[], percentileRank: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileRank / 100) * sorted.length) - 1);
  return sorted[index];
}

test('planning chat send under long transcript pressure does not hitch cheap main-process IPC', async () => {
  const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-planning-chat-hitch-'));
  try {
    const app = await launchElectronApp(testDir);
    try {
      const page = await app.firstWindow({ timeout: 10000 });
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });

      for (let index = 0; index < 6; index += 1) {
        await page.evaluate((planText) => window.invoker.loadPlan(planText), yamlStringify(buildWorkflow(index)));
      }
      await expect.poll(
        () => page.evaluate(() => window.invoker.listWorkflows().then((workflows) => workflows.length)),
        { timeout: 10000 },
      ).toBe(6);

      const threadTs = 'planning-chat-hitch-proof';
      const openResult = await page.evaluate(async ({ threadTs, messageCount, contentBytes }) => {
        const seedTranscript = window.invoker.planningChatSeedTranscript;
        if (!seedTranscript) {
          throw new Error('planningChatSeedTranscript test helper is unavailable');
        }
        await seedTranscript(threadTs, messageCount, contentBytes);
        return window.invoker.planningChatOpen(threadTs);
      }, {
        threadTs,
        messageCount: TRANSCRIPT_MESSAGE_COUNT,
        contentBytes: TRANSCRIPT_CONTENT_BYTES,
      });
      expect(openResult.messageCount).toBe(TRANSCRIPT_MESSAGE_COUNT);

      const result = await page.evaluate(async ({ threadTs, sampleDelayMs, minSamples }) => {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const sendStartedAt = performance.now();
        let sendDone = false;
        const sendPromise = window.invoker
          .planningChatSend(threadTs, 'Summarize the next implementation step.')
          .finally(() => {
            sendDone = true;
          });

        const rtts: number[] = [];
        while ((!sendDone || rtts.length < minSamples) && performance.now() - sendStartedAt < 10_000) {
          const startedAt = performance.now();
          await window.invoker.listWorkflows();
          rtts.push(performance.now() - startedAt);
          await sleep(sampleDelayMs);
        }

        const sendResult = await sendPromise;
        return {
          rtts,
          sendElapsedMs: performance.now() - sendStartedAt,
          sendResult,
        };
      }, {
        threadTs,
        sampleDelayMs: SAMPLE_DELAY_MS,
        minSamples: MIN_RTT_SAMPLES,
      });

      const p95RttMs = percentile(result.rtts, 95);
      const maxRttMs = Math.max(...result.rtts);
      const evidence = {
        metric: 'planning_chat_hitch_responsiveness',
        transcriptMessageCount: TRANSCRIPT_MESSAGE_COUNT,
        transcriptContentBytes: TRANSCRIPT_CONTENT_BYTES,
        workflowCount: 6,
        sampleCount: result.rtts.length,
        p95RttMs: Math.round(p95RttMs),
        maxRttMs: Math.round(maxRttMs),
        sendElapsedMs: Math.round(result.sendElapsedMs),
        p95BudgetMs: P95_RTT_BUDGET_MS,
        maxBudgetMs: MAX_RTT_BUDGET_MS,
      };
      console.log(JSON.stringify(evidence));

      expect(result.sendResult.reply).toBe('Planner deterministic e2e response.');
      expect(result.sendResult.messageCount).toBe(TRANSCRIPT_MESSAGE_COUNT + 2);
      expect(result.rtts.length).toBeGreaterThanOrEqual(MIN_RTT_SAMPLES);
      expect(p95RttMs).toBeLessThanOrEqual(P95_RTT_BUDGET_MS);
      expect(maxRttMs).toBeLessThanOrEqual(MAX_RTT_BUDGET_MS);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
