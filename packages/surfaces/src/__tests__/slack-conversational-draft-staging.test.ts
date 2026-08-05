import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { SQLiteAdapter, ConversationRepository, SlackPlanDraftRepository, SlackSessionRepository, WorkflowChannelRepository } from '@invoker/data-store';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

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
        uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ ok: true, files: [{ id: 'F1' }] }] }),
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

const VALID_PLAN_YAML = `name: "Pink Theme Retheme"
repoUrl: "https://github.com/example/repo.git"
onFinish: pull_request
mergeMode: external_review
baseBranch: master
tasks:
  - id: retheme-tokens
    description: "Swap theme tokens to pink"
    prompt: "Edit index.css"
    dependencies: []
  - id: verify-tokens
    description: "Verify"
    command: "pnpm test"
    dependencies: [retheme-tokens]
`;

async function buildSurface(conversationalPlanning: boolean) {
  const adapter = await SQLiteAdapter.create(':memory:');
  const surface = new SlackSurface({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    signingSecret: 'test-secret',
    channelId: 'C-test',
    cursorCommand: 'cursor',
    workingDir: '/repo',
    defaultRepoUrl: 'https://github.com/example/repo.git',
    conversationalPlanning,
    conversationRepo: new ConversationRepository(adapter),
    slackSessionRepo: new SlackSessionRepository(adapter),
    slackPlanDraftRepo: new SlackPlanDraftRepository(adapter),
    workflowChannelRepo: new WorkflowChannelRepository(adapter),
  });
  await surface.start(async () => {});
  return surface;
}

function mentionHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  const handler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;
  if (!handler) throw new Error('app_mention handler not registered');
  return handler;
}

describe('conversational-planning drafts stage the Slack review card automatically', () => {
  beforeEach(() => {
    conversationInstances.clear();
    nextDraftPlanText = null;
    nextReply = 'Here are some scoping questions.';
  });

  it('a conversational turn that produces a draft posts the review card and uploads the YAML', async () => {
    const surface = await buildSurface(true);
    const say = vi.fn().mockResolvedValue({ ts: 'reply-ts' });
    nextReply = 'Draft ready — pink retheme in 2 steps.';
    nextDraftPlanText = VALID_PLAN_YAML;

    await mentionHandler(surface)({
      event: { text: '<@UBOT> lets change the theme of the app from black to pink', ts: 'thread-pink', user: 'U1' },
      say,
    });

    const cardCall = say.mock.calls.find(([msg]) => typeof msg?.text === 'string' && msg.text.includes('Pink Theme Retheme'));
    expect(cardCall).toBeDefined();
    const app = surface.getApp() as any;
    expect(app.client.files.uploadV2).toHaveBeenCalledTimes(1);
  });

  it('a scoping turn with no draft stages nothing', async () => {
    const surface = await buildSurface(true);
    const say = vi.fn().mockResolvedValue({ ts: 'reply-ts' });

    await mentionHandler(surface)({
      event: { text: '<@UBOT> lets change the theme of the app from black to pink', ts: 'thread-scope', user: 'U1' },
      say,
    });

    const app = surface.getApp() as any;
    expect(app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: 'Here are some scoping questions.' }));
    expect(app.client.files.uploadV2).not.toHaveBeenCalled();
  });

  it('without conversationalPlanning a draft-producing turn does not auto-stage', async () => {
    const surface = await buildSurface(false);
    const say = vi.fn().mockResolvedValue({ ts: 'reply-ts' });
    nextDraftPlanText = VALID_PLAN_YAML;

    await mentionHandler(surface)({
      event: { text: '<@UBOT> lets change the theme of the app from black to pink', ts: 'thread-legacy', user: 'U1' },
      say,
    });

    const app = surface.getApp() as any;
    expect(app.client.files.uploadV2).not.toHaveBeenCalled();
  });
});
