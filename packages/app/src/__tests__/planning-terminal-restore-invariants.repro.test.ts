import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import { ConversationRepository, SQLiteAdapter } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  listPlanningChatSessions,
  restorePlanningChatSessions,
  sendPlanningChatMessage,
  setPlanningChatTerminalMode,
} from '../in-app-planner.js';

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

function planningRecord(overrides: Partial<InAppPlanningSessionRecord> = {}): InAppPlanningSessionRecord {
  return {
    id: 'planning-record',
    title: 'Planning record',
    presetKey: 'codex',
    status: 'still_discussing',
    confirmationMode: 'require',
    messages: [
      {
        id: 1,
        role: 'system',
        text: 'Ask Invoker what you want to build.',
        tone: 'muted',
        createdAt: '2026-07-07T00:00:00.000Z',
      },
    ],
    pendingResponse: false,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    ...overrides,
  };
}

describe('planning terminal restore invariants repro', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // `it.fails`: desired behavior for the fix slice. Current restore drops
  // sessions whose persisted preset key no longer exists, losing the transcript
  // instead of remapping the session to the configured default preset.
  it.fails('remaps a restored planning chat whose preset key is missing', async () => {
    const sessions = createInAppPlanningChatSessions();

    await restorePlanningChatSessions([
      planningRecord({
        id: 'missing-preset-chat',
        title: 'Retired preset chat',
        presetKey: 'retired-preset',
      }),
    ], {
      config: { defaultSlackHarnessPreset: 'codex' },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(sessions.get('missing-preset-chat')).toMatchObject({
      id: 'missing-preset-chat',
      presetKey: 'codex',
      title: 'Retired preset chat',
    });
  });

  it('skips a missing preset without blocking other planning chat restores', async () => {
    const sessions = createInAppPlanningChatSessions();

    await restorePlanningChatSessions([
      planningRecord({
        id: 'missing-preset-chat',
        presetKey: 'retired-preset',
      }),
      planningRecord({
        id: 'known-preset-chat',
        presetKey: 'codex',
        title: 'Known preset chat',
      }),
    ], {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(sessions.has('missing-preset-chat')).toBe(false);
    expect(sessions.get('known-preset-chat')).toMatchObject({
      id: 'known-preset-chat',
      presetKey: 'codex',
      title: 'Known preset chat',
    });
  });

  it('restores submitted tmux sessions idle and still rejects chat sends', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      const record = planningRecord({
        id: 'submitted-tmux-chat',
        title: 'Submitted tmux chat',
        status: 'submitted',
        submittedWorkflowId: 'wf-submitted',
        submittedPlanName: 'Submitted tmux plan',
        terminalMode: 'tmux',
        terminalSessionId: 'term-submitted',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'submitted tmux output\n',
        terminalUpdatedAt: '2026-07-07T00:00:02.000Z',
        pendingResponse: true,
      });
      adapter.upsertInAppPlanningSession(record);

      await restorePlanningChatSessions([record], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      expect(sessions.get('submitted-tmux-chat')).toMatchObject({
        status: 'submitted',
        terminalMode: 'tmux',
        terminalSessionId: 'term-submitted',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'submitted tmux output\n',
      });
      expect(adapter.loadInAppPlanningSession('submitted-tmux-chat')?.pendingResponse).toBe(false);
      await expect(sendPlanningChatMessage({
        sessionId: 'submitted-tmux-chat',
        message: 'change the submitted plan',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      })).resolves.toMatchObject({
        ok: false,
        error: 'This planning session was already submitted. Start a new planning chat for changes.',
      });
    } finally {
      adapter.close();
    }
  });

  it('restores chat-mode sessions with tmux state without opening a new terminal', async () => {
    const sessions = createInAppPlanningChatSessions();

    await restorePlanningChatSessions([
      planningRecord({
        id: 'chat-mode-with-tmux-state',
        terminalMode: 'chat',
        terminalSessionId: 'term-chat-mode',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'saved output\n',
      }),
    ], {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(listPlanningChatSessions({ sessions }).sessions[0]).toMatchObject({
      id: 'chat-mode-with-tmux-state',
      terminalMode: 'chat',
      terminalSessionId: 'term-chat-mode',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'saved output\n',
    });
    expect(setPlanningChatTerminalMode({
      sessionId: 'chat-mode-with-tmux-state',
      mode: 'tmux',
    }, { sessions })).toEqual({ ok: true });
    expect(sessions.get('chat-mode-with-tmux-state')?.terminalSessionId).toBe('term-chat-mode');
  });
});
