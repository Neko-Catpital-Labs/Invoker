import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConversationRepository, SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  bindPlanningTerminalSessionState,
} from '../terminal-session-ipc.js';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSession,
} from '../in-app-planner.js';

const NOW = '2026-07-07T00:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
});

function planningCommandBuilder() {
  return { command: 'planner', args: [] };
}

function planningRecord(overrides: Partial<InAppPlanningSessionRecord> = {}): InAppPlanningSessionRecord {
  return {
    id: 'planning-record',
    title: 'Planning record',
    presetKey: 'codex',
    confirmationMode: 'require',
    status: 'still_discussing',
    messages: [
      {
        id: 1,
        role: 'system',
        text: 'Ask Invoker what you want to build.',
        tone: 'muted',
        createdAt: NOW,
      },
    ],
    pendingResponse: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function planningSession(overrides: Partial<InAppPlanningChatSession> = {}): InAppPlanningChatSession {
  return {
    id: 'planning-session',
    title: 'Planning session',
    presetKey: 'codex',
    confirmationMode: 'require',
    status: 'still_discussing',
    messages: [],
    conversation: {} as any,
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    createdAt: NOW,
    updatedAt: NOW,
    nextMessageId: 1,
    ...overrides,
  };
}

class FakePlanningTerminalManager extends EventEmitter {
  restoreSpawnSession = vi.fn();
}

function restorePersistedPlanningTerminalsFor(sessions: ReturnType<typeof createInAppPlanningChatSessions>) {
  const embeddedTerminalManager = new FakePlanningTerminalManager();
  const bound = bindPlanningTerminalSessionState({
    embeddedTerminalManager: embeddedTerminalManager as any,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    planningChatSessions: sessions,
    getPlanningSessionStore: () => undefined,
    repoRoot: '/repo',
  });
  bound.restorePersistedPlanningTerminals();
  return embeddedTerminalManager.restoreSpawnSession;
}

describe('planning terminal restore invariants repros', () => {
  // it.fails: this is the desired restore behavior. The current restore path
  // drops sessions whose saved preset key no longer exists instead of remapping
  // them to the current default preset and preserving the user-visible chat.
  it.fails('remaps a restored planning chat whose saved preset was removed', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([
        planningRecord({
          id: 'legacy-preset-session',
          title: 'Legacy preset session',
          presetKey: 'legacy-codex',
          terminalMode: 'tmux',
          terminalSessionId: 'term-legacy',
          terminalStatus: 'running',
          terminalOutputSnapshot: 'saved shell\n',
          terminalUpdatedAt: '2026-07-07T00:00:02.000Z',
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
        presetKey: 'codex',
        terminalMode: 'tmux',
        terminalSessionId: 'term-legacy',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'saved shell\n',
      });
    } finally {
      adapter.close();
    }
  });

  it('does not restore a chat-mode planning session even when stale tmux metadata is present', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('chat-mode-session', planningSession({
      id: 'chat-mode-session',
      terminalMode: 'chat',
      terminalSessionId: 'term-stale-chat',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'old tmux output\n',
    }));

    const restoreSpawnSession = restorePersistedPlanningTerminalsFor(sessions);

    expect(restoreSpawnSession).not.toHaveBeenCalled();
  });

  // it.fails: submitted planning chats are read-only and should not restart a
  // writable tmux shell on app restore. The current restore predicate only checks
  // terminalMode/session/status and reopens submitted sessions.
  it.fails('does not restore a submitted planning session tmux process', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-session', planningSession({
      id: 'submitted-session',
      status: 'submitted',
      submittedPlanName: 'Submitted plan',
      submittedWorkflowId: 'wf-submitted',
      terminalMode: 'tmux',
      terminalSessionId: 'term-submitted',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'submitted tmux output\n',
    }));

    const restoreSpawnSession = restorePersistedPlanningTerminalsFor(sessions);

    expect(restoreSpawnSession).not.toHaveBeenCalled();
  });
});
