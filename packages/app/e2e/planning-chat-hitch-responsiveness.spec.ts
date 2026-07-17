import { _electron as electron, expect, test } from '@playwright/test';
import { resolveRepoRoot } from '@invoker/contracts';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = resolveRepoRoot(__dirname);

const THREAD_TS = 'e2e-planning-chat-hitch';
const TRANSCRIPT_MESSAGE_COUNT = 900;
const TRANSCRIPT_MESSAGE_BYTES = 2048;
const TEST_RESPONSE_DELAY_MS = 1500;
const SAMPLE_INTERVAL_MS = 25;
const MIN_SAMPLE_COUNT = 20;
const SEND_TIMEOUT_MS = 10000;
const P95_RTT_BUDGET_MS = 200;
const MAX_RTT_BUDGET_MS = 650;

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
      INVOKER_TEST_FIXED_NOW: '2025-01-01T00:00:00.000Z',
      INVOKER_CLAUDE_COMMAND: claudeMarker,
      INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
      INVOKER_TEST_PLANNING_CHAT_RESPONSE: 'Deterministic planning-chat e2e response.',
      INVOKER_TEST_PLANNING_CHAT_RESPONSE_DELAY_MS: String(TEST_RESPONSE_DELAY_MS),
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
}

function buildTranscriptMessages() {
  const chunk = 'planning transcript pressure '.repeat(Math.ceil(TRANSCRIPT_MESSAGE_BYTES / 29)).slice(0, TRANSCRIPT_MESSAGE_BYTES);
  return Array.from({ length: TRANSCRIPT_MESSAGE_COUNT }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: [{ type: 'text', text: `${index.toString().padStart(4, '0')} ${chunk}` }],
  }));
}

function percentile(values: number[], percentileRank: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileRank / 100) * sorted.length) - 1);
  return sorted[index];
}

test('planning chat send keeps cheap main-process IPC responsive under long transcript pressure', async () => {
  const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-planning-chat-hitch-'));
  try {
    const app = await launchElectronApp(testDir);
    try {
      const page = await app.firstWindow({ timeout: 10000 });
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });

      const seeded = await page.evaluate(async ({ threadTs, messages }) => {
        return window.invoker.seedPlanningChatTranscript!(threadTs, messages);
      }, { threadTs: THREAD_TS, messages: buildTranscriptMessages() });
      expect(seeded.messageCount).toBe(TRANSCRIPT_MESSAGE_COUNT);

      const opened = await page.evaluate((threadTs) => window.invoker.planningChatOpen(threadTs), THREAD_TS);
      expect(opened.messages).toHaveLength(TRANSCRIPT_MESSAGE_COUNT);

      await page.evaluate(({ threadTs }) => {
        const target = window as any;
        target.__planningChatSendSettled = false;
        target.__planningChatSendPromise = window.invoker
          .planningChatSend(threadTs, 'Follow up while the transcript is already open.')
          .finally(() => {
            target.__planningChatSendSettled = true;
          });
      }, { threadTs: THREAD_TS });

      const rtts: number[] = [];
      const deadline = Date.now() + SEND_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const rtt = await page.evaluate(async () => {
          const startedAt = performance.now();
          await window.invoker.listWorkflows();
          return performance.now() - startedAt;
        });
        rtts.push(rtt);

        const settled = await page.evaluate(() => Boolean((window as any).__planningChatSendSettled));
        if (settled && rtts.length >= MIN_SAMPLE_COUNT) break;
        await page.waitForTimeout(SAMPLE_INTERVAL_MS);
      }

      const sendResult = await page.evaluate(async () => (window as any).__planningChatSendPromise);
      expect(sendResult.reply).toBe('Deterministic planning-chat e2e response.');
      expect(rtts.length).toBeGreaterThanOrEqual(MIN_SAMPLE_COUNT);

      const p95Ms = percentile(rtts, 95);
      const maxMs = Math.max(...rtts);
      const evidence = {
        metric: 'planning_chat_send_ipc_rtt',
        samples: rtts.length,
        p95Ms: Number(p95Ms.toFixed(1)),
        maxMs: Number(maxMs.toFixed(1)),
        p95BudgetMs: P95_RTT_BUDGET_MS,
        maxBudgetMs: MAX_RTT_BUDGET_MS,
        transcriptMessages: TRANSCRIPT_MESSAGE_COUNT,
        transcriptBytesPerMessage: TRANSCRIPT_MESSAGE_BYTES,
        responseDelayMs: TEST_RESPONSE_DELAY_MS,
      };
      console.log(`PLANNING_CHAT_HITCH_EVIDENCE ${JSON.stringify(evidence)}`);

      expect(p95Ms).toBeLessThan(P95_RTT_BUDGET_MS);
      expect(maxMs).toBeLessThan(MAX_RTT_BUDGET_MS);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
