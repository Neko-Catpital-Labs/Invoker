import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as child_process from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackSurface } from '../slack/slack-surface.js';
import { SQLiteAdapter, ConversationRepository, SlackPlanDraftRepository, SlackSessionRepository, WorkflowChannelRepository } from '@invoker/data-store';
import type { HarnessSessionDriver } from '@invoker/execution-engine';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

// Real incident, replayed end to end: a Slack thread scopes a fix over
// several turns, a continuity harness (claude) resumes the same session for
// each turn, and only on a later turn does the user authorize drafting. This
// test drives the REAL PlanConversation (no mocking of that class) so the
// turn-2+ reminder fix actually runs, and asserts the real downstream
// Approve/Cancel card gets posted through SlackSurface -- proving the two
// layers (prompt construction, card posting) connect end to end, not just
// in isolation.
vi.mock('@slack/bolt', () => {
  class MockApp {
    _commandHandlers: MockHandler[] = [];
    _actionHandlers: MockHandler[] = [];
    _eventHandlers: MockHandler[] = [];
    command = vi.fn((name: string, handler: Function) => {
      this._commandHandlers.push({ pattern: name, handler });
    });
    action = vi.fn((pattern: string | RegExp, handler: Function) => {
      this._actionHandlers.push({ pattern, handler });
    });
    event = vi.fn((name: string, handler: Function) => {
      this._eventHandlers.push({ pattern: name, handler });
    });
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.123456' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }) },
      files: {
        uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ ok: true, files: [{ id: 'F-REMINDER' }] }] }),
      },
      reactions: { add: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({}) },
    };
  }
  return { App: MockApp };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return { ...actual, spawn: vi.fn() };
});
const mockSpawn = vi.mocked(child_process.spawn);

function createMockProcess(stdout: string, exitCode = 0): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', exitCode);
  }, 0);
  return proc;
}

// Unique to buildPlanDraftReminder's text (plan-conversation.ts) -- distinct
// from buildPlanningHandoffInstructions' turn-1 wording, so this only fires
// on a resumed continuity-harness turn that got the per-turn reminder.
const REMINDER_SIGNATURE = 'Reminder: when the final YAML plan is ready';

const PLAN_YAML = `name: "Fix dev-profile env override clobbering"
repoUrl: "https://github.com/Neko-Catpital-Labs/Invoker.git"
onFinish: pull_request
mergeMode: external_review
baseBranch: master
tasks:
  - id: fix-env-precedence
    description: "Let explicit override vars win over fixed dev-profile paths"
    prompt: "Fix the env merge in with-invoker-development-profile.mjs"
    dependencies: []
  - id: verify-env-precedence
    description: "Verify overrides now win"
    command: "pnpm test"
    dependencies: [fix-env-precedence]
`;

function createContinuityDriver(): HarnessSessionDriver {
  let nextSessionId = 0;
  return {
    harness: 'claude',
    supportsSessionContinuity: true,
    start: (prompt: string) => ({ command: 'claude', args: ['-p', prompt], sessionId: `session-${++nextSessionId}` }),
    append: (sessionId: string, prompt: string) => ({ command: 'claude', args: ['--resume', sessionId, '-p', prompt], sessionId }),
  };
}

function mentionHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  const handler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;
  if (!handler) throw new Error('app_mention handler not registered');
  return handler;
}

describe('replaying the stuck Slack plan-staging thread end to end', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'plan-turn-reminder-repro-'));
    mockSpawn.mockReset();
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('a resumed turn that gets the reminder writes the sidecar file and a real Approve/Cancel card is posted', async () => {
    const driver = createContinuityDriver();
    const safeThreadTs = 'thread-repro'.replace(/[^a-zA-Z0-9._-]/g, '_');
    const planDraftPath = join(workingDir, '.invoker', 'plan-drafts', `${safeThreadTs}.yaml`);

    mockSpawn.mockImplementation((_command, args: any) => {
      const prompt = String(args[args.length - 1]);
      if (prompt.includes(REMINDER_SIGNATURE)) {
        // Simulate a well-behaved model: the sidecar-file write is a tool
        // call, so it happens before the Stop hook's own turn-end word-count
        // check ever runs -- unaffected by that hook either way.
        mkdirSync(join(workingDir, '.invoker', 'plan-drafts'), { recursive: true });
        writeFileSync(planDraftPath, PLAN_YAML, 'utf8');
        return createMockProcess('Plan drafted and staged for approval. Approve to continue, or tell me what to change.');
      }
      return createMockProcess('Got it — before I draft anything, can you confirm the target repo and branch?');
    });

    const onCommand = vi.fn(async () => ({ workflowIds: ['wf-repro'] }));
    const adapter = await SQLiteAdapter.create(':memory:');
    const slackPlanDraftRepo = new SlackPlanDraftRepository(adapter);
    const surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      cursorCommand: 'cursor',
      workingDir,
      defaultRepoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker.git',
      conversationalPlanning: true,
      conversationRepo: new ConversationRepository(adapter),
      slackSessionRepo: new SlackSessionRepository(adapter),
      slackPlanDraftRepo,
      workflowChannelRepo: new WorkflowChannelRepository(adapter),
      harnessSessionDriverFactory: () => driver,
    } as any);
    await surface.start(onCommand as never);

    // Turn 1: investigation/scoping, no draft yet. Establishes the
    // continuity session (turn 1 gets its instructions via the full
    // system prompt, a separate code path this fix doesn't touch).
    await mentionHandler(surface)({
      event: { text: '<@UBOT> help me figure out why the PRs are not being requeued', ts: 'thread-repro', user: 'U1' },
      say: vi.fn().mockResolvedValue({ ts: 'reply-1' }),
    });
    expect(slackPlanDraftRepo.getReady('C-test', 'thread-repro')).toBeUndefined();

    // Turn 2: resumed session, same thread. Before the fix, this turn's
    // prompt never repeated the sidecar-file instruction and the model
    // could drift to pasting YAML inline -- which a downstream word-count
    // guard then truncates, losing the draft. With the fix, the reminder
    // is present, so the mock "model" above writes the file and the real
    // capture + card-posting path runs.
    const sayTurn2 = vi.fn().mockResolvedValue({ ts: 'reply-2' });
    await mentionHandler(surface)({
      event: { text: '<@UBOT> figure out which commit broke it and then plan', ts: 'thread-repro-2', thread_ts: 'thread-repro', user: 'U1' },
      say: sayTurn2,
    });

    const draft = slackPlanDraftRepo.getReady('C-test', 'thread-repro');
    expect(draft).toBeDefined();
    expect(draft?.status).toBe('ready');

    const approveCard = sayTurn2.mock.calls.find(([msg]: [any]) =>
      JSON.stringify(msg?.blocks ?? []).includes('plan_draft_approve'));
    expect(approveCard).toBeDefined();
    const blocks = JSON.stringify(approveCard[0].blocks);
    expect(blocks).toContain('plan_draft_approve');
    expect(blocks).toContain('plan_draft_cancel');
    expect(blocks).toContain('Approve');
    expect(blocks).toContain('Cancel');

    // Full circle: clicking Approve actually submits, proving the card is
    // wired to a live plan, not a decorative artifact.
    await (function actionHandler() {
      const app = surface.getApp() as any;
      const handler = app._actionHandlers.find((h: MockHandler) => h.pattern === 'plan_draft_approve')?.handler;
      if (!handler) throw new Error('plan_draft_approve action handler not registered');
      return handler;
    })()({
      action: { type: 'button', value: `${draft!.draftId}:${draft!.version}` },
      body: { channel: { id: draft!.channelId }, message: { thread_ts: draft!.threadTs }, user: { id: 'U1' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'start_plan', planText: draft!.planText }));
  });
});
