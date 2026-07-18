import { expect, test } from './fixtures/electron-app.js';

const SAMPLE_INTERVAL_MS = 75;
const MAX_SEND_WINDOW_MS = 10_000;
const SEND_RESPONSE_DELAY_MS = 2_500;
const TRANSCRIPT_MESSAGE_COUNT = 4_000;
const TRANSCRIPT_MESSAGE_BYTES = 2_048;
const MAX_P95_RTT_MS = 150;
const MAX_SAMPLE_RTT_MS = 250;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

test('planning chat send keeps listWorkflows IPC responsive under long transcript pressure', async ({ page }) => {
  await expect(page.getByTestId('workflow-graph-surface')).toBeVisible();

  const threadTs = `planning-chat-hitch-${Date.now()}`;
  const responseOverride = 'Deterministic planning chat hitch response';

  const result = await page.evaluate(
    async ({
      threadTs,
      responseOverride,
      responseDelayMs,
      sampleIntervalMs,
      maxSendWindowMs,
      transcriptMessageCount,
      transcriptMessageBytes,
    }) => {
      const invoker = window.invoker;
      if (!invoker.planningChatSeedTranscript || !invoker.planningChatOpen || !invoker.planningChatSend) {
        throw new Error('planning chat test IPC is not exposed (NODE_ENV=test required)');
      }

      const seed = await invoker.planningChatSeedTranscript(
        threadTs,
        transcriptMessageCount,
        transcriptMessageBytes,
      );
      const open = await invoker.planningChatOpen(threadTs);

      const samples: number[] = [];
      let settled = false;
      const sendStartedAt = performance.now();
      const sendPromise = invoker.planningChatSend(
        threadTs,
        'continue the plan with one deterministic turn',
        { responseOverride, responseDelayMs },
      ).finally(() => {
        settled = true;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      while (!settled && performance.now() - sendStartedAt < maxSendWindowMs) {
        const startedAt = performance.now();
        await invoker.listWorkflows();
        samples.push(performance.now() - startedAt);
        await new Promise<void>((resolve) => setTimeout(resolve, sampleIntervalMs));
      }

      const send = await sendPromise;
      return { seed, open, send, samples };
    },
    {
      threadTs,
      responseOverride,
      responseDelayMs: SEND_RESPONSE_DELAY_MS,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      maxSendWindowMs: MAX_SEND_WINDOW_MS,
      transcriptMessageCount: TRANSCRIPT_MESSAGE_COUNT,
      transcriptMessageBytes: TRANSCRIPT_MESSAGE_BYTES,
    },
  );

  expect(result.seed.messageCount).toBe(TRANSCRIPT_MESSAGE_COUNT);
  expect(result.open.messageCount).toBe(TRANSCRIPT_MESSAGE_COUNT);
  expect(result.send.reply).toBe(responseOverride);
  expect(result.send.messageCount).toBe(TRANSCRIPT_MESSAGE_COUNT + 2);
  expect(result.samples.length).toBeGreaterThanOrEqual(12);

  const sorted = [...result.samples].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1]!;
  const evidence = {
    metric: 'planning_chat_send_hitch',
    threadTs,
    transcriptMessageCount: TRANSCRIPT_MESSAGE_COUNT,
    transcriptBytesApprox: TRANSCRIPT_MESSAGE_COUNT * TRANSCRIPT_MESSAGE_BYTES,
    sendElapsedMs: result.send.elapsedMs,
    sampleCount: result.samples.length,
    p95RttMs: Number(p95.toFixed(1)),
    maxRttMs: Number(max.toFixed(1)),
    budget: {
      p95RttMs: MAX_P95_RTT_MS,
      maxRttMs: MAX_SAMPLE_RTT_MS,
    },
  };
  console.log(`[planning-chat-hitch] ${JSON.stringify(evidence)}`);

  expect(
    p95,
    `p95 IPC RTT ${p95.toFixed(1)}ms exceeded ${MAX_P95_RTT_MS}ms `
      + `(max=${max.toFixed(1)}ms, n=${result.samples.length})`,
  ).toBeLessThanOrEqual(MAX_P95_RTT_MS);
  expect(
    max,
    `max IPC RTT ${max.toFixed(1)}ms exceeded ${MAX_SAMPLE_RTT_MS}ms `
      + `(p95=${p95.toFixed(1)}ms, n=${result.samples.length})`,
  ).toBeLessThanOrEqual(MAX_SAMPLE_RTT_MS);
});
