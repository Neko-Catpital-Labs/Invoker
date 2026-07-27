import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRepository, SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  listPlanningChatSessions,
  restorePlanningChatSessions,
} from '../in-app-planner.js';

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

afterEach(() => {
  vi.restoreAllMocks();
});

function planningRecord(overrides: Partial<InAppPlanningSessionRecord> = {}): InAppPlanningSessionRecord {
  return {
    id: 'planning-restore-record',
    title: 'Planning restore record',
    presetKey: 'codex',
    status: 'still_discussing',
    messages: [
      {
        id: 1,
        role: 'user',
        text: 'Restore this planning chat',
        createdAt: '2026-07-07T00:00:01.000Z',
      },
    ],
    pendingResponse: false,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:02.000Z',
    ...overrides,
  };
}

describe('planning terminal restore invariants repro', () => {
  // `it.fails`: restoring must not silently drop a visible planning chat just
  // because its saved preset key was removed or renamed. The desired recovery is
  // to keep the chat and remap it to the current default preset.
  it.fails('restores a saved planning chat by remapping a missing preset instead of dropping it', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([
        planningRecord({
          id: 'legacy-preset-planning-chat',
          title: 'Legacy preset planning chat',
          presetKey: 'cursor+retired',
        }),
      ], {
        config: { defaultSlackHarnessPreset: 'codex' },
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      expect(sessions.get('legacy-preset-planning-chat')).toMatchObject({
        id: 'legacy-preset-planning-chat',
        title: 'Legacy preset planning chat',
        presetKey: 'codex',
      });
      expect(listPlanningChatSessions({ sessions }).sessions.map((session) => session.id)).toContain('legacy-preset-planning-chat');
    } finally {
      adapter.close();
    }
  });

  it('restores submitted chat-mode sessions with their saved tmux attachment still addressable', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([
        planningRecord({
          id: 'submitted-chat-mode-with-tmux',
          title: 'Submitted chat-mode tmux',
          status: 'submitted',
          submittedWorkflowId: 'wf-submitted',
          submittedPlanName: 'Submitted chat-mode tmux',
          terminalMode: 'chat',
          terminalSessionId: 'term-submitted-chat-mode',
          terminalStatus: 'running',
          terminalOutputSnapshot: 'saved tmux output\n',
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

      expect(sessions.get('submitted-chat-mode-with-tmux')).toMatchObject({
        status: 'submitted',
        terminalMode: 'chat',
        terminalSessionId: 'term-submitted-chat-mode',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'saved tmux output\n',
      });
      expect(listPlanningChatSessions({ sessions }).sessions[0]).toMatchObject({
        id: 'submitted-chat-mode-with-tmux',
        status: 'submitted',
        terminalMode: 'chat',
        terminalSessionId: 'term-submitted-chat-mode',
        terminalStatus: 'running',
        draftPlanAvailable: false,
      });
    } finally {
      adapter.close();
    }
  });
});
