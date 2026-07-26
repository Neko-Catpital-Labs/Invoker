import { describe, it, expect, vi } from 'vitest';
import { ConversationRepository, SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  listPlanningChatSessions,
  restorePlanningChatSessions,
  sendPlanningChatMessage,
} from '../in-app-planner.js';

const CREATED_AT = '2026-07-07T00:00:00.000Z';
const UPDATED_AT = '2026-07-07T00:00:01.000Z';

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

function makePlanningRecord(overrides: Partial<InAppPlanningSessionRecord> = {}): InAppPlanningSessionRecord {
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
        createdAt: CREATED_AT,
      },
    ],
    pendingResponse: false,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('planning terminal restore invariants repros', () => {
  it('repro: missing restore presets drop sessions while a remapped custom preset restores', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([
        makePlanningRecord({
          id: 'missing-preset-session',
          title: 'Missing preset session',
          presetKey: 'removed-preset',
        }),
        makePlanningRecord({
          id: 'remapped-preset-session',
          title: 'Remapped preset session',
          presetKey: 'legacy-codex',
        }),
      ], {
        config: {
          slackHarnessPresets: {
            'legacy-codex': { tool: 'codex' },
          },
        },
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      expect(sessions.has('missing-preset-session')).toBe(false);
      expect(sessions.get('remapped-preset-session')).toMatchObject({
        id: 'remapped-preset-session',
        presetKey: 'legacy-codex',
      });
      expect(listPlanningChatSessions({ sessions }).sessions.map((session) => session.id)).toEqual([
        'remapped-preset-session',
      ]);
    } finally {
      adapter.close();
    }
  });

  it('repro: submitted chat-mode restore preserves saved tmux identity but refuses new chat turns', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      const conversationRepo = new ConversationRepository(adapter);
      await restorePlanningChatSessions([
        makePlanningRecord({
          id: 'submitted-chat-mode-tmux',
          title: 'Submitted chat mode with tmux',
          status: 'submitted',
          submittedWorkflowId: 'wf-submitted',
          submittedPlanName: 'Submitted plan',
          terminalMode: 'chat',
          terminalSessionId: 'term-submitted-chat-mode',
          terminalStatus: 'running',
          terminalOutputSnapshot: 'submitted tmux output\n',
          terminalUpdatedAt: '2026-07-07T00:00:02.000Z',
        }),
      ], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo,
        planningSessionStore: adapter,
      });

      expect(sessions.get('submitted-chat-mode-tmux')).toMatchObject({
        status: 'submitted',
        terminalMode: 'chat',
        terminalSessionId: 'term-submitted-chat-mode',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'submitted tmux output\n',
      });
      expect(listPlanningChatSessions({ sessions }).sessions[0]).toMatchObject({
        id: 'submitted-chat-mode-tmux',
        terminalMode: 'chat',
        terminalSessionId: 'term-submitted-chat-mode',
        submittedWorkflowId: 'wf-submitted',
      });

      await expect(sendPlanningChatMessage({
        sessionId: 'submitted-chat-mode-tmux',
        message: 'change the submitted plan',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo,
        planningSessionStore: adapter,
      })).resolves.toEqual({
        ok: false,
        sessionId: 'submitted-chat-mode-tmux',
        error: 'This planning session was already submitted. Start a new planning chat for changes.',
      });
    } finally {
      adapter.close();
    }
  });
});
