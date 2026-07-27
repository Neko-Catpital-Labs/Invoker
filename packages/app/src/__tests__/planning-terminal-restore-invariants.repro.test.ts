import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRepository, SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSession,
} from '../in-app-planner.js';
import { bindPlanningTerminalSessionState } from '../terminal-session-ipc.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

function makeRecord(overrides: Partial<InAppPlanningSessionRecord> = {}): InAppPlanningSessionRecord {
  return {
    id: 'planning-restore-record',
    title: 'Restored planning chat',
    presetKey: 'codex',
    status: 'still_discussing',
    messages: [
      {
        id: 1,
        role: 'user',
        text: 'Restore this transcript',
        createdAt: '2026-07-07T00:00:00.000Z',
      },
    ],
    pendingResponse: false,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    ...overrides,
  };
}

function makeSession(overrides: Partial<InAppPlanningChatSession>): InAppPlanningChatSession {
  return {
    id: 'planning-session',
    title: 'Planning session',
    presetKey: 'codex',
    confirmationMode: 'require',
    status: 'still_discussing',
    messages: [],
    conversation: new PlanConversation({}),
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    nextMessageId: 1,
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    ...overrides,
  };
}

describe('planning terminal restore invariants repro', () => {
  // `it.fails`: this asserts the desired restore contract. Current restore
  // drops chats whose persisted preset key is no longer configured.
  it.fails('falls back to the default preset instead of dropping a restored chat with a missing preset', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      const record = makeRecord({
        id: 'restored-missing-preset',
        presetKey: 'removed-custom-preset',
        title: 'Missing preset should restore',
      });

      await restorePlanningChatSessions([record], {
        config: {
          defaultSlackHarnessPreset: 'codex',
        },
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      expect(sessions.get('restored-missing-preset')).toMatchObject({
        id: 'restored-missing-preset',
        presetKey: 'codex',
        title: 'Missing preset should restore',
        messages: expect.arrayContaining([
          expect.objectContaining({ text: 'Restore this transcript' }),
        ]),
      });
    } finally {
      adapter.close();
    }
  });

  // `it.fails`: this asserts the desired restore contract. Current terminal
  // restore can revive tmux for an already submitted planning session.
  it.fails('does not restore tmux processes for submitted or chat-mode planning sessions', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-tmux', makeSession({
      id: 'submitted-tmux',
      status: 'submitted',
      submittedWorkflowId: 'wf-submitted',
      submittedPlanName: 'Submitted plan',
      terminalMode: 'tmux',
      terminalSessionId: 'terminal-submitted',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'submitted tmux output\n',
    }));
    sessions.set('chat-mode-with-terminal-metadata', makeSession({
      id: 'chat-mode-with-terminal-metadata',
      terminalMode: 'chat',
      terminalSessionId: 'terminal-chat-mode',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'chat mode output\n',
    }));

    const restoreSpawnSession = vi.fn();
    const embeddedTerminalManager = Object.assign(new EventEmitter(), {
      restoreSpawnSession,
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    bindPlanningTerminalSessionState({
      embeddedTerminalManager: embeddedTerminalManager as never,
      logger,
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo',
    }).restorePersistedPlanningTerminals();

    expect(restoreSpawnSession).not.toHaveBeenCalled();
  });
});
