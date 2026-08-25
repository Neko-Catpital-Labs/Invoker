import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import {
  SQLiteAdapter,
  ConversationRepository,
  SlackPlanDraftRepository,
  SlackSessionRepository,
  WorkflowChannelRepository,
  type PlanningDraft,
} from '@invoker/data-store';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

/**
 * Repro for DO1 thread 1787644363.867779 (2026-08-25):
 * doctor-approved YAML bytes already carry the pinned repoUrl and a blank line;
 * normalizeDraftedPlanRepoUrl parse+stringify drops the blank line, so the
 * post-doctor exact-match gate throws and no Approve card is staged.
 */
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
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue({
          ok: true,
          files: [{ ok: true, files: [{ id: 'F-DOCTOR' }] }],
        }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      },
    };
  }
  return { App: MockApp };
});

const PINNED_REPO = 'https://github.com/Neko-Catpital-Labs/Invoker.git';

/** Doctor-approved bytes: same repoUrl as the thread pin, plus a blank line stringify drops. */
const DOCTOR_APPROVED_YAML = [
  'name: UI overwhelm batch',
  'onFinish: none',
  'mergeMode: manual',
  `repoUrl: ${PINNED_REPO}`,
  '',
  'tasks:',
  '  - id: write-long-session-pathological-repro',
  '    description: |',
  '      Write packages/app/e2e/long-session-pathological.spec.ts',
  '    prompt: |',
  '      must add the spec',
  '    dependencies: []',
].join('\n');

let nextDraftPlanText: string | null = null;
let nextApprovedDraft: PlanningDraft | null = null;
let nextReply = 'Draft ready.';

vi.mock('../slack/plan-conversation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../slack/plan-conversation.js')>()),
  PlanConversation: vi.fn((config: any) => {
    const instance = {
      _config: config,
      workingDir: config?.workingDir,
      submittedPlanText: null as string | null,
      planSubmitted: false,
      conversationMode: config?.mode ?? 'plan',
      lastTurnDraftPlanText: null as string | null,
      approvedPlanningDraft: null as PlanningDraft | null,
      draftDoctorEnabled: true,
      lastTurnPlanIntentSignal: null,
      lastTurnReasoning: [] as string[],
      init: vi.fn().mockResolvedValue(undefined),
      getDraftedPlan: () => instance.lastTurnDraftPlanText,
      runPlanConversion: vi.fn().mockImplementation(async () => {
        instance.lastTurnDraftPlanText = nextDraftPlanText;
        instance.approvedPlanningDraft = nextApprovedDraft;
        return nextReply;
      }),
      sendMessage: vi.fn().mockImplementation(async () => {
        instance.lastTurnDraftPlanText = nextDraftPlanText;
        instance.approvedPlanningDraft = nextApprovedDraft;
        return nextReply;
      }),
      reset: vi.fn(),
      history: [],
    };
    return instance;
  }),
}));

async function buildSurface(onCommand: (command: unknown) => Promise<unknown>) {
  const adapter = await SQLiteAdapter.create(':memory:');
  const conversationRepo = new ConversationRepository(adapter);
  const slackPlanDraftRepo = new SlackPlanDraftRepository(adapter);
  const surface = new SlackSurface({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    signingSecret: 'test-secret',
    channelId: 'C-test',
    cursorCommand: 'cursor',
    workingDir: '/repo',
    defaultRepoUrl: PINNED_REPO,
    conversationalPlanning: true,
    conversationRepo,
    slackSessionRepo: new SlackSessionRepository(adapter),
    slackPlanDraftRepo,
    workflowChannelRepo: new WorkflowChannelRepository(adapter),
  });
  await surface.start(onCommand as never);
  return { surface, slackPlanDraftRepo, conversationRepo };
}

function mentionHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  const handler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;
  if (!handler) throw new Error('app_mention handler not registered');
  return handler;
}

function actionHandler(surface: SlackSurface, actionId: string): Function {
  const app = surface.getApp() as any;
  const handler = app._actionHandlers.find((h: MockHandler) => h.pattern === actionId)?.handler;
  if (!handler) throw new Error(`${actionId} action handler not registered`);
  return handler;
}

describe('Slack doctor-draft stringify clash (DO1 1787644363)', () => {
  beforeEach(() => {
    nextDraftPlanText = null;
    nextApprovedDraft = null;
    nextReply = 'Draft ready.';
  });

  // it.fails: asserts the desired behavior; stage+submit still drop the
  // immutable doctor bytes today. A later fix slice removes `.fails`.
  it.fails('stages and Approves the exact doctor-approved bytes when stringify would drop a blank line', async () => {
    const onCommand = vi.fn(async () => ({ workflowIds: ['wf-doctor-1'] }));
    const { surface, slackPlanDraftRepo, conversationRepo } = await buildSurface(onCommand);
    const say = vi.fn().mockResolvedValue({ ts: 'card-ts' });

    const approved = conversationRepo.planningDrafts.createCurrent('thread-doctor', DOCTOR_APPROVED_YAML);
    nextDraftPlanText = approved.planText;
    nextApprovedDraft = approved;

    await mentionHandler(surface)({
      event: { text: '<@UBOT> draft the overwhelm batch', ts: 'thread-doctor', user: 'U1' },
      say,
    });

    const draft = slackPlanDraftRepo.getReady('C-test', 'thread-doctor');
    expect(draft).toBeDefined();
    expect(draft?.status).toBe('ready');
    expect(draft?.planText).toBe(approved.planText);
    expect(draft?.planningDraftId).toBe(approved.id);

    const readyCard = say.mock.calls.find(([msg]: [any]) =>
      JSON.stringify(msg?.blocks ?? []).includes('plan_draft_approve'));
    expect(readyCard).toBeDefined();

    await actionHandler(surface, 'plan_draft_approve')({
      action: { type: 'button', value: `${draft!.draftId}:${draft!.version}` },
      body: { channel: { id: draft!.channelId }, message: { thread_ts: draft!.threadTs }, user: { id: 'U1' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'start_plan',
      planText: approved.planText,
      repoUrl: PINNED_REPO,
    }));
  });
});
