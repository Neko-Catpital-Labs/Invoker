import { describe, it, expect, vi } from 'vitest';
import { ConversationRepository, SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
} from '../in-app-planner.js';
import { bindPlanningTerminalSessionState } from '../terminal-session-ipc.js';

function planningRecord(
  overrides: Partial<InAppPlanningSessionRecord> = {},
): InAppPlanningSessionRecord {
  return {
    id: 'planning-record',
    title: 'Planning record',
    presetKey: 'codex',
    status: 'still_discussing',
    messages: [
      {
        id: 1,
        role: 'user',
        text: 'Restore this planning terminal',
        createdAt: '2026-07-07T00:00:01.000Z',
      },
    ],
    draftPlanSummary: undefined,
    draftPlanText: undefined,
    pendingResponse: false,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:02.000Z',
    ...overrides,
  };
}

function planningDeps(adapter: SQLiteAdapter) {
  return {
    config: {},
    loadGeneratedPlan: vi.fn(),
    sessions: createInAppPlanningChatSessions(),
    planningCommandBuilder: vi.fn(() => ({ command: 'planner', args: [] })),
    conversationRepo: new ConversationRepository(adapter),
    planningSessionStore: adapter,
  };
}

describe('planning terminal restore invariants repro', () => {
  it.fails('remaps a restored planning chat whose saved preset no longer exists', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const deps = planningDeps(adapter);

      await restorePlanningChatSessions([
        planningRecord({
          id: 'planning-missing-preset',
          title: 'Missing preset chat',
          presetKey: 'custom-preset-removed-from-config',
        }),
      ], deps);

      expect(deps.sessions.get('planning-missing-preset')).toMatchObject({
        id: 'planning-missing-preset',
        presetKey: 'codex',
        title: 'Missing preset chat',
      });
      expect(adapter.loadInAppPlanningSession('planning-missing-preset')).toMatchObject({
        presetKey: 'codex',
      });
    } finally {
      adapter.close();
    }
  });

  it('restores submitted tmux sessions but skips chat-mode terminal leftovers', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const deps = planningDeps(adapter);
      await restorePlanningChatSessions([
        planningRecord({
          id: 'submitted-tmux',
          title: 'Submitted tmux',
          status: 'submitted',
          submittedWorkflowId: 'wf-submitted',
          submittedPlanName: 'Submitted Plan',
          terminalMode: 'tmux',
          terminalSessionId: 'term-submitted',
          terminalStatus: 'running',
          terminalOutputSnapshot: 'submitted tmux output\n',
          terminalUpdatedAt: '2026-07-07T00:00:03.000Z',
        }),
        planningRecord({
          id: 'chat-mode-leftover',
          title: 'Chat mode leftover',
          terminalMode: 'chat',
          terminalSessionId: 'term-chat-leftover',
          terminalStatus: 'running',
          terminalOutputSnapshot: 'chat mode terminal output\n',
          terminalUpdatedAt: '2026-07-07T00:00:04.000Z',
        }),
      ], deps);

      const restoreSpawnSession = vi.fn();
      const embeddedTerminalManager = {
        on: vi.fn(),
        restoreSpawnSession,
      };
      const { restorePersistedPlanningTerminals } = bindPlanningTerminalSessionState({
        embeddedTerminalManager: embeddedTerminalManager as any,
        logger: { warn: vi.fn(), info: vi.fn() },
        planningChatSessions: deps.sessions,
        getPlanningSessionStore: () => adapter,
        repoRoot: '/repo',
      });

      restorePersistedPlanningTerminals();

      expect(restoreSpawnSession).toHaveBeenCalledTimes(1);
      expect(restoreSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'term-submitted',
        taskId: 'planning:submitted-tmux',
        kind: 'planning',
        planningSessionId: 'submitted-tmux',
        cwd: '/repo',
        outputSnapshot: 'submitted tmux output\n',
      }));
      expect(restoreSpawnSession).not.toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'term-chat-leftover',
      }));
    } finally {
      adapter.close();
    }
  });
});
