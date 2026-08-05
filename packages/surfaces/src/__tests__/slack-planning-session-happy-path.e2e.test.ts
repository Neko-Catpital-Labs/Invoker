import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { SQLiteAdapter, ConversationRepository, SlackPlanDraftRepository, SlackSessionRepository, WorkflowChannelRepository } from '@invoker/data-store';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

// End-to-end happy path for a Slack planning session against the real
// files.uploadV2 response shape (each element of the top-level `files` array
// is a completeUploadExternal response with its own nested `files` array):
// mention → conversational turn drafts a plan → review card staged ready with
// an Approve button → Approve click → start_plan command → draft submitted.
// submitSlackPlanDraft refuses drafts with no bound slackFileId, so this whole
// path only works when the uploaded file id is read from the right place.
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
          files: [{ ok: true, files: [{ id: 'F-SESSION' }] }],
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

let nextDraftPlanText: string | null = null;
let nextReply = 'Here are some scoping questions.';

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
      lastTurnPlanIntentSignal: null,
      lastTurnReasoning: [] as string[],
      init: vi.fn().mockResolvedValue(undefined),
      getDraftedPlan: () => instance.lastTurnDraftPlanText,
      runPlanConversion: vi.fn().mockResolvedValue(''),
      sendMessage: vi.fn().mockImplementation(async () => {
        instance.lastTurnDraftPlanText = nextDraftPlanText;
        return nextReply;
      }),
      reset: vi.fn(),
      history: [],
    };
    return instance;
  }),
}));

const VALID_PLAN_YAML = `name: "CodeRabbit Audit"
repoUrl: "https://github.com/example/repo.git"
onFinish: pull_request
mergeMode: external_review
baseBranch: master
tasks:
  - id: audit-findings
    description: "Audit review findings"
    prompt: "Check the review comments"
    dependencies: []
  - id: verify-audit
    description: "Verify"
    command: "pnpm test"
    dependencies: [audit-findings]
`;

async function buildSurface(onCommand: (command: unknown) => Promise<unknown>) {
  const adapter = await SQLiteAdapter.create(':memory:');
  const slackPlanDraftRepo = new SlackPlanDraftRepository(adapter);
  const surface = new SlackSurface({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    signingSecret: 'test-secret',
    channelId: 'C-test',
    cursorCommand: 'cursor',
    workingDir: '/repo',
    defaultRepoUrl: 'https://github.com/example/repo.git',
    conversationalPlanning: true,
    conversationRepo: new ConversationRepository(adapter),
    slackSessionRepo: new SlackSessionRepository(adapter),
    slackPlanDraftRepo,
    workflowChannelRepo: new WorkflowChannelRepository(adapter),
  });
  await surface.start(onCommand as never);
  return { surface, slackPlanDraftRepo };
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

describe('slack planning session happy path', () => {
  beforeEach(() => {
    nextDraftPlanText = null;
    nextReply = 'Here are some scoping questions.';
  });

  it('mention → draft → ready review card → Approve → plan submitted with workflow ids recorded', async () => {
    const onCommand = vi.fn(async () => ({ workflowIds: ['wf-e2e-1'] }));
    const { surface, slackPlanDraftRepo } = await buildSurface(onCommand);
    const say = vi.fn().mockResolvedValue({ ts: 'card-ts' });
    nextReply = 'Draft ready.';
    nextDraftPlanText = VALID_PLAN_YAML;

    await mentionHandler(surface)({
      event: { text: '<@UBOT> audit the coderabbit findings', ts: 'thread-happy', user: 'U1' },
      say,
    });

    const draft = slackPlanDraftRepo.getReady('C-test', 'thread-happy');
    expect(draft).toBeDefined();
    expect(draft?.status).toBe('ready');
    expect(draft?.slackFileId).toBe('F-SESSION');
    expect(draft?.messageTs).toBeTruthy();

    const app = surface.getApp() as any;
    const readyCard = app.client.chat.update.mock.calls.find(([msg]: [any]) =>
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
      planText: draft!.planText,
      repoUrl: 'https://github.com/example/repo.git',
    }));
    expect(draft?.planText).toContain('name: "CodeRabbit Audit"');

    const submitted = slackPlanDraftRepo.get(draft!.draftId, draft!.version);
    expect(submitted?.status).toBe('submitted');
    expect(JSON.parse(submitted?.workflowIdsJson ?? '[]')).toEqual(['wf-e2e-1']);
  });

  it('a scoping turn with no draft stages nothing to approve', async () => {
    const onCommand = vi.fn(async () => ({ workflowIds: ['wf-never'] }));
    const { surface, slackPlanDraftRepo } = await buildSurface(onCommand);
    const say = vi.fn().mockResolvedValue({ ts: 'reply-ts' });

    await mentionHandler(surface)({
      event: { text: '<@UBOT> audit the coderabbit findings', ts: 'thread-scoping', user: 'U1' },
      say,
    });

    expect(slackPlanDraftRepo.getReady('C-test', 'thread-scoping')).toBeUndefined();
    expect(onCommand).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'start_plan' }));
  });
});
