import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRepository, SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  listPlanningChatSessions,
  restorePlanningChatSessions,
  sendPlanningChatMessage,
} from '../in-app-planner.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

function planningRecord(overrides: Partial<InAppPlanningSessionRecord>): InAppPlanningSessionRecord {
  return {
    id: 'planning-record',
    title: 'Planning record',
    presetKey: 'codex',
    status: 'still_discussing',
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

describe('planning terminal restore invariants repros', () => {
  it('reproduces missing restore presets being dropped instead of remapped to the current default', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([
        planningRecord({
          id: 'legacy-remapped-preset',
          title: 'Legacy preset',
          presetKey: 'legacy+removed',
        }),
        planningRecord({
          id: 'current-default-preset',
          title: 'Current preset',
          presetKey: 'codex',
        }),
      ], {
        config: { defaultSlackHarnessPreset: 'omp+claude' },
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      expect(sessions.has('legacy-remapped-preset')).toBe(false);
      expect(sessions.get('current-default-preset')?.presetKey).toBe('codex');
      expect(listPlanningChatSessions({ sessions }).sessions.map((session) => session.id)).toEqual(['current-default-preset']);
    } finally {
      adapter.close();
    }
  });

  it('reproduces submitted tmux restore and stale chat-mode terminal ownership', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([
        planningRecord({
          id: 'submitted-tmux',
          title: 'Submitted tmux',
          status: 'submitted',
          submittedWorkflowId: 'wf-submitted',
          submittedPlanName: 'Submitted tmux',
          terminalMode: 'tmux',
          terminalSessionId: 'term-submitted-tmux',
          terminalStatus: 'running',
          terminalOutputSnapshot: 'submitted tmux output\n',
          terminalUpdatedAt: '2026-07-07T00:00:03.000Z',
        }),
        planningRecord({
          id: 'chat-mode-with-terminal',
          title: 'Chat mode with stale terminal',
          terminalMode: 'chat',
          terminalSessionId: 'term-chat-mode-stale',
          terminalStatus: 'running',
          terminalOutputSnapshot: 'stale terminal output\n',
          terminalUpdatedAt: '2026-07-07T00:00:04.000Z',
        }),
      ], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      expect(sessions.get('submitted-tmux')).toMatchObject({
        status: 'submitted',
        terminalMode: 'tmux',
        terminalSessionId: 'term-submitted-tmux',
        terminalStatus: 'running',
      });
      await expect(sendPlanningChatMessage({
        sessionId: 'submitted-tmux',
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

      expect(listPlanningChatSessions({ sessions }).sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'chat-mode-with-terminal',
          terminalMode: 'chat',
          terminalSessionId: 'term-chat-mode-stale',
          terminalOutputSnapshot: 'stale terminal output\n',
        }),
      ]));
    } finally {
      adapter.close();
    }
  });
});
