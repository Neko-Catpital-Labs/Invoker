import { describe, expect, it, vi } from 'vitest';

import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';

import {
  createSlackBugScanWorker,
  registerSlackBugScanWorker,
  SLACK_BUG_SCAN_WORKER_KIND,
  type SlackBugScanClassifier,
  type SlackBugScanPlanSubmitter,
} from '../workers/slack-bug-scan-worker.js';
import type { SlackBugScanChannelSummary, SlackBugScanClient, SlackBugScanMessage } from '../workers/slack-bug-scan-client.js';

function makeLogger() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  logger.child.mockImplementation(() => logger as any);
  return logger as any;
}

function makeStore() {
  const rows = new Map<string, WorkerActionRecord>();
  return {
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => rows.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((action: WorkerActionWrite): WorkerActionRecord => {
      const record: WorkerActionRecord = {
        ...action,
        createdAt: rows.get(action.id)?.createdAt ?? action.updatedAt,
      } as WorkerActionRecord;
      rows.set(action.id, record);
      return record;
    }),
    rows,
  };
}

function makeClient(channels: SlackBugScanChannelSummary[], messagesByChannel: Map<string, SlackBugScanMessage[]>) {
  const posted: Array<{ channelId: string; threadTs: string; text: string }> = [];
  const client: SlackBugScanClient = {
    async listMemberChannels() {
      return channels;
    },
    async listHistorySince(channelId, oldestTs) {
      const all = messagesByChannel.get(channelId) ?? [];
      if (!oldestTs) return all;
      const cutoff = Number(oldestTs);
      return all.filter((m) => Number(m.ts) > cutoff);
    },
    async listReplies(channelId, threadTs) {
      const all = messagesByChannel.get(channelId) ?? [];
      return all.filter((m) => m.ts === threadTs || m.threadTs === threadTs);
    },
    async postMessage(channelId, threadTs, text) {
      posted.push({ channelId, threadTs, text });
      return { ts: `${Date.now()}` };
    },
  };
  return { client, posted };
}

const CHANNEL_WITH_REPO: SlackBugScanChannelSummary = {
  id: 'C1',
  name: 'general',
  topic: 'repo: git@github.com:acme/widgets.git',
};
const CHANNEL_NO_REPO: SlackBugScanChannelSummary = { id: 'C2', name: 'random' };

// The worker seeds a channel's watermark to a real wall-clock Slack ts (epoch
// seconds) on first sight, so test fixture messages must use realistic
// epoch-scale timestamps that sort after "now" — a literal like '2000' would
// always be older than any real watermark and would never be picked up.
function bugMessage(offsetSeconds: number, text = 'the login button is broken and throws an error'): SlackBugScanMessage {
  return { ts: String(Date.now() / 1000 + offsetSeconds), user: 'U1', text };
}

describe('slack-bug-scan worker', () => {
  it('registers under the expected kind', () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerSlackBugScanWorker(registry);
    expect(registry.get(SLACK_BUG_SCAN_WORKER_KIND)).toBeTruthy();
  });

  it('skips a channel with no parseable repo url in topic/purpose', async () => {
    const store = makeStore();
    const messages = new Map([[CHANNEL_NO_REPO.id, [bugMessage(1)]]]);
    const { client } = makeClient([CHANNEL_NO_REPO], messages);
    const classify = vi.fn();
    const draftAndSubmitPlan = vi.fn();

    const runtime = createSlackBugScanWorker({
      logger: makeLogger(), client, store, classify, draftAndSubmitPlan,
      intervalMs: 0, tickOnStart: false,
    });
    await runtime.tick('manual');
    await runtime.tick('manual'); // second tick so watermark seeding doesn't mask the assertion

    expect(classify).not.toHaveBeenCalled();
  });

  it('seeds the watermark to now on first sight and does not scan backlog', async () => {
    const store = makeStore();
    const messages = new Map([[CHANNEL_WITH_REPO.id, [bugMessage(1)]]]);
    const { client } = makeClient([CHANNEL_WITH_REPO], messages);
    const classify = vi.fn(async () => ({ isBugComplaint: true, problemStatement: 'x' }));
    const draftAndSubmitPlan = vi.fn(async () => ({ planName: 'P', workflowId: 'wf-1' }));

    const runtime = createSlackBugScanWorker({
      logger: makeLogger(), client, store, classify, draftAndSubmitPlan,
      intervalMs: 0, tickOnStart: false,
    });
    await runtime.tick('manual'); // first sight: seeds watermark, does not scan the pre-existing message

    expect(classify).not.toHaveBeenCalled();
  });

  it('classifies a new complaint after the watermark and submits it', async () => {
    const store = makeStore();
    const messages = new Map<string, SlackBugScanMessage[]>([[CHANNEL_WITH_REPO.id, []]]);
    const { client, posted } = makeClient([CHANNEL_WITH_REPO], messages);
    const classify: SlackBugScanClassifier = vi.fn(async () => ({ isBugComplaint: true, problemStatement: 'login is broken' }));
    const draftAndSubmitPlan: SlackBugScanPlanSubmitter = vi.fn(async () => ({ planName: 'Fix login', workflowId: 'wf-1' }));

    const runtime = createSlackBugScanWorker({
      logger: makeLogger(), client, store, classify, draftAndSubmitPlan,
      intervalMs: 0, tickOnStart: false,
    });
    await runtime.tick('manual'); // seed watermark

    messages.set(CHANNEL_WITH_REPO.id, [bugMessage(2)]);
    await runtime.tick('manual');

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith(expect.objectContaining({ repoUrl: 'git@github.com:acme/widgets.git' }));
    expect(draftAndSubmitPlan).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.text).toContain('wf-1');
  });

  it('does not submit when classification says it is not a bug', async () => {
    const store = makeStore();
    const messages = new Map<string, SlackBugScanMessage[]>([[CHANNEL_WITH_REPO.id, []]]);
    const { client, posted } = makeClient([CHANNEL_WITH_REPO], messages);
    const classify: SlackBugScanClassifier = vi.fn(async () => ({ isBugComplaint: false }));
    const draftAndSubmitPlan: SlackBugScanPlanSubmitter = vi.fn();

    const runtime = createSlackBugScanWorker({
      logger: makeLogger(), client, store, classify, draftAndSubmitPlan,
      intervalMs: 0, tickOnStart: false,
    });
    await runtime.tick('manual');
    messages.set(CHANNEL_WITH_REPO.id, [bugMessage(2)]);
    await runtime.tick('manual');

    expect(classify).toHaveBeenCalledTimes(1);
    expect(draftAndSubmitPlan).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });

  it('does not re-submit the same complaint across ticks (fingerprint dedup)', async () => {
    const store = makeStore();
    const sameMessage = bugMessage(2, 'the login button is broken');
    const messages = new Map<string, SlackBugScanMessage[]>([[CHANNEL_WITH_REPO.id, []]]);
    const { client } = makeClient([CHANNEL_WITH_REPO], messages);
    const classify: SlackBugScanClassifier = vi.fn(async () => ({ isBugComplaint: true, problemStatement: 'x' }));
    const draftAndSubmitPlan: SlackBugScanPlanSubmitter = vi.fn(async () => ({ planName: 'P', workflowId: 'wf-1' }));

    const runtime = createSlackBugScanWorker({
      logger: makeLogger(), client, store, classify, draftAndSubmitPlan,
      intervalMs: 0, tickOnStart: false,
    });
    await runtime.tick('manual'); // seed
    messages.set(CHANNEL_WITH_REPO.id, [sameMessage]);
    await runtime.tick('manual'); // submits

    // Same message stays in channel history (as Slack would show it) and may still be
    // >= the watermark on this tick — dedup relies on the fingerprint ledger, not the
    // watermark, to keep this a no-op.
    await runtime.tick('manual');

    expect(draftAndSubmitPlan).toHaveBeenCalledTimes(1);
  });

  it('allows a second, genuinely different complaint in the same thread', async () => {
    const store = makeStore();
    const messages = new Map<string, SlackBugScanMessage[]>([[CHANNEL_WITH_REPO.id, []]]);
    const { client } = makeClient([CHANNEL_WITH_REPO], messages);
    const classify: SlackBugScanClassifier = vi.fn(async () => ({ isBugComplaint: true, problemStatement: 'x' }));
    const draftAndSubmitPlan: SlackBugScanPlanSubmitter = vi.fn(async () => ({ planName: 'P', workflowId: 'wf-1' }));

    const runtime = createSlackBugScanWorker({
      logger: makeLogger(), client, store, classify, draftAndSubmitPlan,
      intervalMs: 0, tickOnStart: false,
    });
    await runtime.tick('manual'); // seed

    messages.set(CHANNEL_WITH_REPO.id, [bugMessage(2, 'the login button is broken')]);
    await runtime.tick('manual');

    messages.set(CHANNEL_WITH_REPO.id, [
      bugMessage(2, 'the login button is broken'),
      bugMessage(3, 'the logout button now crashes the app'),
    ]);
    await runtime.tick('manual');

    expect(draftAndSubmitPlan).toHaveBeenCalledTimes(2);
  });

  it('posts a non-silent failure message when plan submission fails', async () => {
    const store = makeStore();
    const messages = new Map<string, SlackBugScanMessage[]>([[CHANNEL_WITH_REPO.id, []]]);
    const { client, posted } = makeClient([CHANNEL_WITH_REPO], messages);
    const classify: SlackBugScanClassifier = vi.fn(async () => ({ isBugComplaint: true, problemStatement: 'x' }));
    const draftAndSubmitPlan: SlackBugScanPlanSubmitter = vi.fn(async () => {
      throw new Error('planner exploded');
    });

    const runtime = createSlackBugScanWorker({
      logger: makeLogger(), client, store, classify, draftAndSubmitPlan,
      intervalMs: 0, tickOnStart: false,
    });
    await runtime.tick('manual');
    messages.set(CHANNEL_WITH_REPO.id, [bugMessage(2)]);
    await runtime.tick('manual');

    expect(posted).toHaveLength(1);
    expect(posted[0]?.text).toContain('planner exploded');
  });

  it('advances the watermark even on ticks with no candidates', async () => {
    const store = makeStore();
    const messages = new Map<string, SlackBugScanMessage[]>([[CHANNEL_WITH_REPO.id, []]]);
    const { client } = makeClient([CHANNEL_WITH_REPO], messages);
    const classify: SlackBugScanClassifier = vi.fn();
    const draftAndSubmitPlan: SlackBugScanPlanSubmitter = vi.fn();

    const runtime = createSlackBugScanWorker({
      logger: makeLogger(), client, store, classify, draftAndSubmitPlan,
      intervalMs: 0, tickOnStart: false,
    });
    await runtime.tick('manual');
    const firstWatermark = store.rows.get(`${SLACK_BUG_SCAN_WORKER_KIND}:channel-watermark:${CHANNEL_WITH_REPO.id}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.tick('manual');
    const secondWatermark = store.rows.get(`${SLACK_BUG_SCAN_WORKER_KIND}:channel-watermark:${CHANNEL_WITH_REPO.id}`);

    expect(secondWatermark?.updatedAt).not.toBe(firstWatermark?.updatedAt);
    expect(classify).not.toHaveBeenCalled();
  });

  it('enforces the per-tick submission cap, deferring rather than dropping candidates', async () => {
    const store = makeStore();
    const channelB: SlackBugScanChannelSummary = { id: 'C3', name: 'ops', topic: 'repo: git@github.com:acme/ops.git' };
    const messages = new Map<string, SlackBugScanMessage[]>([[CHANNEL_WITH_REPO.id, []], [channelB.id, []]]);
    const { client } = makeClient([CHANNEL_WITH_REPO, channelB], messages);
    const classify: SlackBugScanClassifier = vi.fn(async () => ({ isBugComplaint: true, problemStatement: 'x' }));
    const draftAndSubmitPlan: SlackBugScanPlanSubmitter = vi.fn(async () => ({ planName: 'P', workflowId: 'wf-1' }));

    const runtime = createSlackBugScanWorker({
      logger: makeLogger(), client, store, classify, draftAndSubmitPlan,
      intervalMs: 0, tickOnStart: false, maxAutoSubmissionsPerTick: 1,
    });
    await runtime.tick('manual'); // seed both channels

    messages.set(CHANNEL_WITH_REPO.id, [bugMessage(2, 'the login button is broken')]);
    messages.set(channelB.id, [bugMessage(2, 'the deploy pipeline is broken')]);
    await runtime.tick('manual');

    expect(draftAndSubmitPlan).toHaveBeenCalledTimes(1);
  });

  it('enforces the daily submission cap and posts a cap-hit message instead of submitting', async () => {
    const store = makeStore();
    const messages = new Map<string, SlackBugScanMessage[]>([[CHANNEL_WITH_REPO.id, []]]);
    const { client, posted } = makeClient([CHANNEL_WITH_REPO], messages);
    const classify: SlackBugScanClassifier = vi.fn(async () => ({ isBugComplaint: true, problemStatement: 'x' }));
    const draftAndSubmitPlan: SlackBugScanPlanSubmitter = vi.fn(async () => ({ planName: 'P', workflowId: 'wf-1' }));

    const runtime = createSlackBugScanWorker({
      logger: makeLogger(), client, store, classify, draftAndSubmitPlan,
      intervalMs: 0, tickOnStart: false, maxAutoSubmissionsPerDay: 1, maxAutoSubmissionsPerTick: 5,
    });
    await runtime.tick('manual'); // seed

    messages.set(CHANNEL_WITH_REPO.id, [bugMessage(2, 'bug one is broken')]);
    await runtime.tick('manual');
    expect(draftAndSubmitPlan).toHaveBeenCalledTimes(1);

    messages.set(CHANNEL_WITH_REPO.id, [
      bugMessage(2, 'bug one is broken'),
      bugMessage(3, 'bug two crashes on load'),
    ]);
    await runtime.tick('manual');

    expect(draftAndSubmitPlan).toHaveBeenCalledTimes(1);
    expect(posted.some((p) => p.text.includes('cap'))).toBe(true);
  });
});
