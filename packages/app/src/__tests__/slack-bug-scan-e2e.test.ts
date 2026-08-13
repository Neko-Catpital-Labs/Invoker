import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import { createSlackBugScanWorker } from '@invoker/execution-engine';
import { createRealSlackBugScanClient, createSlackBugScanClassifier } from '@invoker/slack-bug-scan';
import { PlanConversation } from '@invoker/surfaces';
import { createSlackBugScanPlanner } from '../slack-bug-scan-planner.js';
import type { PlanningRepoPool } from '../planning-chat-worktree.js';
import type { InvokerConfig } from '../config.js';

// This test wires the REAL Slack client, the REAL LLM classifier, the REAL
// plan-submission path (real SQLite persistence, real Orchestrator), and the
// REAL worker tick loop together. Only genuinely external network/LLM
// boundaries are stubbed: the Slack HTTP API, the Anthropic HTTP API, and the
// coding-agent planning session -- the same three boundaries this repo's own
// tests already stub for equivalent reasons (see in-app-planner.test.ts).

const mocks = vi.hoisted(() => ({
  usersConversations: vi.fn(),
  conversationsInfo: vi.fn(),
  conversationsHistory: vi.fn(),
  conversationsReplies: vi.fn(),
  chatPostMessage: vi.fn(),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    users = { conversations: mocks.usersConversations };
    conversations = { info: mocks.conversationsInfo, history: mocks.conversationsHistory, replies: mocks.conversationsReplies };
    chat = { postMessage: mocks.chatPostMessage };
    constructor(_token: string) {}
  },
}));

function makeLogger() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  logger.child.mockImplementation(() => logger as any);
  return logger as any;
}

function makeFakeRepoPool(worktreePath: string): PlanningRepoPool {
  return {
    async ensureCloneThroughRepoQueue() {},
    async resolveBaseCommit() {
      return 'deadbeef';
    },
    async acquireWorktree() {
      return {
        clonePath: worktreePath,
        worktreePath,
        branch: 'invoker/planning/fake',
        release: async () => {},
        softRelease: () => {},
      } as any;
    },
    externalWorktreePath() {
      return worktreePath;
    },
  };
}

const DRAFTED_PLAN = `Here is the plan.

\`\`\`yaml
name: Fix login bug
repoUrl: git@github.com:acme/widgets.git
onFinish: none
tasks:
  - id: fix-login
    description: Fix the login bug
    command: echo fix
\`\`\``;

describe('slack-bug-scan full pipeline (real client, real classifier, real plan submission)', () => {
  const adapters: SQLiteAdapter[] = [];
  const worktreeDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
    for (const dir of worktreeDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function makeHarness() {
    const persistence = await SQLiteAdapter.create(':memory:', { ownerCapability: true });
    adapters.push(persistence);
    const orchestrator = new Orchestrator({
      persistence: persistence as any,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
      deferRunningUntilLaunch: true,
    });

    const client = createRealSlackBugScanClient({ ...process.env, SLACK_BOT_TOKEN: 'xoxb-test' })!;
    const classify = createSlackBugScanClassifier({
      messages: {
        parse: vi.fn(async () => ({
          stop_reason: 'end_turn',
          parsed_output: { isBugComplaint: true, problemStatement: 'The login button is broken.' },
        })),
      },
    } as any);

    const worktreeDir = mkdtempSync(path.join(tmpdir(), 'slack-bug-scan-e2e-'));
    worktreeDirs.push(worktreeDir);
    const config: InvokerConfig = {};
    const draftAndSubmitPlan = createSlackBugScanPlanner({
      config,
      repoPool: makeFakeRepoPool(worktreeDir),
      persistence,
      orchestrator,
      logger: makeLogger(),
    });

    const worker = createSlackBugScanWorker({
      logger: makeLogger(),
      client,
      store: persistence,
      classify,
      draftAndSubmitPlan,
      intervalMs: 0,
      tickOnStart: false,
    });

    return { worker, persistence };
  }

  it('takes a synthetic Slack bug report through classification, real plan submission, and a real Slack reply', async () => {
    vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue(DRAFTED_PLAN);

    mocks.usersConversations.mockResolvedValue({
      channels: [{ id: 'C1', name: 'bugs' }],
      response_metadata: {},
    });
    mocks.conversationsInfo.mockResolvedValue({
      channel: { topic: { value: 'repo: git@github.com:acme/widgets.git' }, purpose: { value: '' } },
    });

    const { worker, persistence } = await makeHarness();

    await worker.tick('manual'); // first sight: seeds the channel watermark, never calls listHistorySince
    expect(mocks.conversationsHistory).not.toHaveBeenCalled();

    const nowTs = String(Date.now() / 1000 + 5);
    const bugMessage = { ts: nowTs, user: 'U1', text: 'the login button is broken and throws an error' };
    mocks.conversationsHistory.mockResolvedValueOnce({
      messages: [bugMessage],
      response_metadata: {},
    });

    await worker.tick('manual');

    expect(mocks.chatPostMessage).toHaveBeenCalledTimes(1);
    const [posted] = mocks.chatPostMessage.mock.calls[0];
    expect(posted.text).toMatch(/^Filed as workflow `wf-/);

    const workflows = persistence.listWorkflows();
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.name).toBe('Fix login bug');

    const workflowId = workflows[0]!.id;
    expect(posted.text).toContain(workflowId);

    const watermarkRow = persistence.getWorkerAction?.('slack-bug-scan', 'channel-watermark:C1');
    expect(watermarkRow?.status).toBe('completed');

    // Slack channel history naturally still contains this same message on the
    // next poll. It must not double-file, proving dedup survives through the
    // real SQLite-backed ledger, not just an in-memory test double.
    mocks.conversationsHistory.mockResolvedValueOnce({
      messages: [bugMessage],
      response_metadata: {},
    });
    await worker.tick('manual');

    expect(mocks.chatPostMessage).toHaveBeenCalledTimes(1);
    expect(persistence.listWorkflows()).toHaveLength(1);
  });

  it('classifies a false positive and never touches plan submission or Slack', async () => {
    mocks.usersConversations.mockResolvedValue({
      channels: [{ id: 'C2', name: 'chatter' }],
      response_metadata: {},
    });
    mocks.conversationsInfo.mockResolvedValue({
      channel: { topic: { value: 'repo: git@github.com:acme/widgets.git' }, purpose: { value: '' } },
    });

    const persistence = await SQLiteAdapter.create(':memory:', { ownerCapability: true });
    adapters.push(persistence);
    const client = createRealSlackBugScanClient({ ...process.env, SLACK_BOT_TOKEN: 'xoxb-test' })!;
    const parse = vi.fn(async () => ({
      stop_reason: 'end_turn',
      parsed_output: { isBugComplaint: false, problemStatement: '' },
    }));
    const classify = createSlackBugScanClassifier({ messages: { parse } } as any);
    const draftAndSubmitPlan = vi.fn();

    const worker = createSlackBugScanWorker({
      logger: makeLogger(),
      client,
      store: persistence,
      classify,
      draftAndSubmitPlan,
      intervalMs: 0,
      tickOnStart: false,
    });

    await worker.tick('manual'); // first sight: seeds the watermark
    mocks.conversationsHistory.mockResolvedValueOnce({
      messages: [{ ts: String(Date.now() / 1000 + 5), user: 'U1', text: 'this is broken again, ugh' }],
      response_metadata: {},
    });
    await worker.tick('manual');

    expect(parse).toHaveBeenCalledTimes(1); // the real classifier really ran against the real thread text
    expect(draftAndSubmitPlan).not.toHaveBeenCalled();
    expect(mocks.chatPostMessage).not.toHaveBeenCalled();
    expect(persistence.listWorkflows()).toHaveLength(0);
  });
});
