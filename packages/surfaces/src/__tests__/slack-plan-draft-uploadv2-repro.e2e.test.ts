import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { SQLiteAdapter, ConversationRepository, SlackPlanDraftRepository, SlackSessionRepository, WorkflowChannelRepository } from '@invoker/data-store';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

// Repro for the production failure "Plan review could not attach YAML: Slack
// did not return an uploaded YAML file id." (Slack thread C0BCNM0UTFY/
// 1785890604.484199): @slack/web-api's files.uploadV2 resolves with one
// files.completeUploadExternal response per upload job, so each element of the
// top-level `files` array has its own nested `files` array. Every other test
// in this suite mocked the flat shape `{ files: [{ id }] }`, which is why the
// bug never failed a test. This suite mocks the real nested shape.
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
          files: [
            {
              ok: true,
              files: [
                {
                  id: 'F-REAL-UPLOAD',
                  created: 1785890604,
                  name: 'plan.yaml',
                  title: 'plan.yaml',
                },
              ],
            },
          ],
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

const conversationInstances = new Map<string, any>();
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
    if (config?.threadTs) conversationInstances.set(config.threadTs, instance);
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

async function buildSurface() {
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
  await surface.start(async () => {});
  return { surface, slackPlanDraftRepo };
}

function mentionHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  const handler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;
  if (!handler) throw new Error('app_mention handler not registered');
  return handler;
}

describe('plan draft staging with the real files.uploadV2 response shape', () => {
  beforeEach(() => {
    conversationInstances.clear();
    nextDraftPlanText = null;
    nextReply = 'Here are some scoping questions.';
  });

  it('reads the file id from the nested completeUploadExternal responses and marks the draft ready', async () => {
    const { surface, slackPlanDraftRepo } = await buildSurface();
    const say = vi.fn().mockResolvedValue({ ts: 'card-ts' });
    nextReply = 'Draft ready.';
    nextDraftPlanText = VALID_PLAN_YAML;

    await mentionHandler(surface)({
      event: { text: '<@UBOT> audit the coderabbit findings', ts: 'thread-real-shape', user: 'U1' },
      say,
    });

    const app = surface.getApp() as any;
    expect(app.client.files.uploadV2).toHaveBeenCalledTimes(1);

    const attachFailure = app.client.chat.update.mock.calls.find(([msg]: [any]) =>
      typeof msg?.text === 'string' && msg.text.startsWith('Plan review could not attach YAML'));
    expect(attachFailure).toBeUndefined();

    const draft = slackPlanDraftRepo.getReady('C-test', 'thread-real-shape');
    expect(draft).toBeDefined();
    expect(draft?.status).toBe('ready');
    expect(draft?.slackFileId).toBe('F-REAL-UPLOAD');
  });

  it('posts the review card with the Approve button once the upload completes', async () => {
    const { surface } = await buildSurface();
    const say = vi.fn().mockResolvedValue({ ts: 'card-ts' });
    nextReply = 'Draft ready.';
    nextDraftPlanText = VALID_PLAN_YAML;

    await mentionHandler(surface)({
      event: { text: '<@UBOT> audit the coderabbit findings', ts: 'thread-approve-button', user: 'U1' },
      say,
    });

    const app = surface.getApp() as any;
    const readyCard = app.client.chat.update.mock.calls.find(([msg]: [any]) =>
      JSON.stringify(msg?.blocks ?? []).includes('plan_draft_approve'));
    expect(readyCard).toBeDefined();
  });
});
