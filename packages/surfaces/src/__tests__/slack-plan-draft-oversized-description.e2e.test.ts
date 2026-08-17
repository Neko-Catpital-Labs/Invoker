import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { SQLiteAdapter, ConversationRepository, SlackPlanDraftRepository, SlackSessionRepository, WorkflowChannelRepository } from '@invoker/data-store';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

// End-to-end regression for the "invalid_blocks" Slack error: mention → a
// conversational turn drafts a plan whose task description is long enough
// that the joined summary text used to exceed Slack's 3000-char mrkdwn
// section-text limit → review card auto-staged. Slack's API itself is
// mocked (not hermetic/safe for CI), but the real app_mention handler,
// PlanConversation-to-draft wiring, and postSlackPlanDraft/planDraftBlocks
// block-building all run for real, so this proves the outbound payload a
// real user's oversized plan would produce stays under Slack's limit.
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

let nextDraftPlanText: string | null = null;

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
        return 'Draft ready.';
      }),
      reset: vi.fn(),
      history: [],
    };
    return instance;
  }),
}));

const LONG_DESCRIPTION = [
  'Goal: retheme the entire application from the current black-based dark palette to a pink-based dark palette.',
  'Motivation: the black theme reads as flat and low-contrast against our new brand pink; users have asked for a warmer dark mode.',
  'Alternative considerations: a light pink theme was considered and rejected because it clashes with syntax-highlighted code blocks.',
  'Implementation details: swap every CSS custom property under --color-bg-*, --color-surface-*, and --color-accent-* in index.css and every themed component stylesheet, update the Tailwind config token map, regenerate the design-token snapshot tests, and update Storybook fixtures so visual regression baselines stay accurate across every themed surface in the app.',
  'Acceptance criteria: every screen in the design-token snapshot suite renders with the new pink palette, no black-palette hex values remain in the codebase, and the visual-proof screenshots show the before/after diff clearly.',
].join(' ').repeat(4);

function mentionHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  const handler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;
  if (!handler) throw new Error('app_mention handler not registered');
  return handler;
}

describe('a drafted plan with an oversized task description does not trip Slack invalid_blocks', () => {
  beforeEach(() => {
    nextDraftPlanText = null;
  });

  // TODO(slack-plan-review-block-limit fix slice): flip to `it` once planDraftBlocks clamps its text.
  it.fails('clamps the review card mrkdwn text to 3000 chars instead of posting an oversized block', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
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
      slackPlanDraftRepo: new SlackPlanDraftRepository(adapter),
      workflowChannelRepo: new WorkflowChannelRepository(adapter),
    });
    await surface.start(async () => {});

    nextDraftPlanText = `name: "UI dark theme: black to pink palette"
repoUrl: "https://github.com/example/repo.git"
onFinish: pull_request
mergeMode: external_review
baseBranch: master
tasks:
  - id: retheme-tokens
    description: "${LONG_DESCRIPTION}"
    prompt: "Edit index.css"
    dependencies: []
`;

    const say = vi.fn().mockResolvedValue({ ts: 'reply-ts' });
    await mentionHandler(surface)({
      event: { text: '<@UBOT> lets change the theme of the app from black to pink', ts: 'thread-pink', user: 'U1' },
      say,
    });

    const cardCall = say.mock.calls.find(([msg]) => Array.isArray(msg?.blocks));
    expect(cardCall).toBeDefined();
    const [message] = cardCall!;
    const sectionBlock = message.blocks.find((block: any) => block.type === 'section');
    expect(sectionBlock.text.text.length).toBeLessThanOrEqual(3000);
  });
});
