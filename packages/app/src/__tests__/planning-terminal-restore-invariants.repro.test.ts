import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ConversationRepository, SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';
import type { TerminalSessionDescriptor } from '@invoker/contracts';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSession,
} from '../in-app-planner.js';
import { bindPlanningTerminalSessionState } from '../terminal-session-ipc.js';

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: [] }));

function planningRecord(overrides: Partial<InAppPlanningSessionRecord> = {}): InAppPlanningSessionRecord {
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
        createdAt: '2026-07-26T00:00:00.000Z',
      },
    ],
    pendingResponse: false,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:01.000Z',
    ...overrides,
  };
}

function planningSession(overrides: Partial<InAppPlanningChatSession> = {}): InAppPlanningChatSession {
  return {
    id: 'planning-session',
    title: 'Planning session',
    presetKey: 'codex',
    status: 'still_discussing',
    messages: [],
    conversation: {} as any,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:01.000Z',
    nextMessageId: 1,
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    ...overrides,
  };
}

function bindRestoreHarness(sessions: ReturnType<typeof createInAppPlanningChatSessions>) {
  const restoreSpawnSession = vi.fn((seed: { sessionId: string; taskId: string }): TerminalSessionDescriptor => ({
    sessionId: seed.sessionId,
    taskId: seed.taskId,
    kind: 'planning',
    planningSessionId: seed.taskId.replace(/^planning:/, ''),
    status: 'running',
    mode: 'spawn',
    attached: false,
    createdAt: '2026-07-26T00:00:02.000Z',
  }));
  const embeddedTerminalManager = Object.assign(new EventEmitter(), {
    restoreSpawnSession,
  });
  const bound = bindPlanningTerminalSessionState({
    embeddedTerminalManager: embeddedTerminalManager as any,
    logger: { info: vi.fn(), warn: vi.fn() },
    planningChatSessions: sessions,
    getPlanningSessionStore: () => undefined,
    repoRoot: '/repo',
  });
  return { restoreSpawnSession, ...bound };
}

describe('planning terminal restore invariants repro', () => {
  // `it.fails` asserts the desired behavior. Current restore drops a saved chat
  // entirely when its persisted preset key is no longer present in config.
  it.fails('keeps a saved planning chat visible when its preset key was removed or remapped', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();

      await restorePlanningChatSessions([
        planningRecord({
          id: 'legacy-preset-chat',
          title: 'Legacy preset chat',
          presetKey: 'legacy-omp-claude',
        }),
      ], {
        config: {
          defaultSlackHarnessPreset: 'codex',
        },
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      expect(sessions.get('legacy-preset-chat')).toMatchObject({
        title: 'Legacy preset chat',
        presetKey: 'codex',
      });
    } finally {
      adapter.close();
    }
  });

  it('does not restore a stale tmux session while the planning chat is in chat mode', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('chat-mode-session', planningSession({
      id: 'chat-mode-session',
      terminalMode: 'chat',
      terminalSessionId: 'tmux-that-should-not-restore',
      terminalStatus: 'running',
    }));
    const harness = bindRestoreHarness(sessions);

    harness.restorePersistedPlanningTerminals();

    expect(harness.restoreSpawnSession).not.toHaveBeenCalled();
  });

  // `it.fails` asserts the desired behavior. Current restore revives tmux for a
  // submitted planning session even though submitted chats are read-only.
  it.fails('does not restore tmux for an already submitted planning chat', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-session', planningSession({
      id: 'submitted-session',
      status: 'submitted',
      submittedWorkflowId: 'wf-submitted',
      submittedPlanName: 'Submitted plan',
      terminalMode: 'tmux',
      terminalSessionId: 'tmux-submitted-session',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'submitted tmux output\n',
    }));
    const harness = bindRestoreHarness(sessions);

    harness.restorePersistedPlanningTerminals();

    expect(harness.restoreSpawnSession).not.toHaveBeenCalled();
  });
});
