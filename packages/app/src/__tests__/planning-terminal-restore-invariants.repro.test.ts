import { describe, expect, it, vi } from 'vitest';
import { ConversationRepository, SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  createPlanningCommandBuilderFromRegistry,
  listPlanningChatSessions,
  restorePlanningChatSessions,
} from '../in-app-planner.js';
import { bindPlanningTerminalSessionState } from '../terminal-session-ipc.js';

const planningCommandBuilder = createPlanningCommandBuilderFromRegistry({
  getPlanningOrThrow: vi.fn(() => ({
    buildPlanningCommand: vi.fn(() => ({ command: 'codex', args: ['--model', 'fast', 'prompt'] })),
  })),
});

function makePlanningRecord(
  overrides: Partial<InAppPlanningSessionRecord> = {},
): InAppPlanningSessionRecord {
  return {
    id: 'planning-restore',
    title: 'Restored plan',
    presetKey: 'codex',
    status: 'still_discussing',
    confirmationMode: 'require',
    messages: [
      {
        id: 1,
        role: 'assistant',
        text: 'Restored reply.',
        createdAt: '2026-07-07T00:00:01.000Z',
      },
    ],
    pendingResponse: false,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    ...overrides,
  };
}

describe('planning terminal restore invariants repros', () => {
  // `it.fails`: desired behavior is that a legacy/missing preset does not make
  // a persisted planning chat disappear. Current restore skips the whole record.
  it.fails('remaps a missing restored preset to the configured default instead of dropping the chat', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([
        makePlanningRecord({
          id: 'legacy-preset-session',
          presetKey: 'legacy-planner',
        }),
      ], {
        config: { defaultSlackHarnessPreset: 'codex' },
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      expect(sessions.get('legacy-preset-session')).toMatchObject({
        id: 'legacy-preset-session',
        presetKey: 'codex',
      });
      expect(listPlanningChatSessions({ sessions }).sessions).toHaveLength(1);
    } finally {
      adapter.close();
    }
  });

  it('restores a remapped custom preset when the config defines that preset key', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([
        makePlanningRecord({
          id: 'custom-remapped-session',
          presetKey: 'team-planner',
        }),
      ], {
        config: {
          slackHarnessPresets: {
            'team-planner': { tool: 'codex', model: 'gpt-5-codex' },
          },
          defaultSlackHarnessPreset: 'team-planner',
        },
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      expect(listPlanningChatSessions({ sessions }).sessions[0]).toMatchObject({
        id: 'custom-remapped-session',
        presetKey: 'team-planner',
      });
    } finally {
      adapter.close();
    }
  });

  // `it.fails`: desired behavior is that a submitted read-only chat still
  // restores its owned tmux session even if the last selected UI mode was chat.
  // Current restore only revives sessions whose terminalMode is already tmux.
  it.fails('restores submitted chat-mode planning tmux sessions for read-only inspection', () => {
    const restoreSpawnSession = vi.fn();
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-chat-mode', {
      id: 'submitted-chat-mode',
      title: 'Submitted plan',
      presetKey: 'codex',
      confirmationMode: 'require',
      status: 'submitted',
      messages: [],
      conversation: {} as never,
      submittedWorkflowId: 'wf-submitted',
      submittedPlanName: 'Submitted plan',
      terminalMode: 'chat',
      terminalSessionId: 'planning-term-submitted',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'tmux output before restart\n',
      terminalUpdatedAt: '2026-07-07T00:00:03.000Z',
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:04.000Z',
      nextMessageId: 1,
    });

    const binding = bindPlanningTerminalSessionState({
      embeddedTerminalManager: {
        on: vi.fn(),
        restoreSpawnSession,
      } as never,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo',
    });

    binding.restorePersistedPlanningTerminals();

    expect(restoreSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'planning-term-submitted',
      kind: 'planning',
      planningSessionId: 'submitted-chat-mode',
      outputSnapshot: 'tmux output before restart\n',
    }));
  });
});
