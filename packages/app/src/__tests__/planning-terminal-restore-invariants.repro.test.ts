import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  bindPlanningTerminalSessionState,
} from '../terminal-session-ipc.js';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSession,
} from '../in-app-planner.js';

const planningCommandBuilder = () => ({ command: 'true', args: [] });
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
};

function makeRecord(overrides: Partial<InAppPlanningSessionRecord> = {}): InAppPlanningSessionRecord {
  return {
    id: 'legacy-preset-session',
    title: 'Legacy preset session',
    presetKey: 'legacy-codex',
    status: 'still_discussing',
    confirmationMode: 'require',
    messages: [
      { id: 1, role: 'user', text: 'Restore this planning chat.', createdAt: '2026-07-07T00:00:01.000Z' },
    ],
    terminalMode: 'tmux',
    terminalSessionId: 'term-legacy-preset',
    terminalStatus: 'running',
    terminalOutputSnapshot: 'legacy tmux output\n',
    terminalUpdatedAt: '2026-07-07T00:00:02.000Z',
    pendingResponse: false,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:02.000Z',
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
    conversation: {} as InAppPlanningChatSession['conversation'],
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    nextMessageId: 1,
    ...overrides,
  };
}

class FakePlanningTerminalManager extends EventEmitter {
  restoreCalls: unknown[] = [];

  restoreSpawnSession(opts: unknown) {
    this.restoreCalls.push(opts);
    return opts;
  }
}

// Expected failures: restore currently drops chats whose persisted preset is no
// longer available, and it will restore a tmux process for submitted planning
// sessions when the persisted terminal mode still says tmux.
describe('planning terminal restore invariants repro', () => {
  it.fails('restores a missing/remapped preset conversation instead of dropping its terminal state', async () => {
    const sessions = createInAppPlanningChatSessions();

    await restorePlanningChatSessions([makeRecord()], {
      config: { defaultSlackHarnessPreset: 'codex' },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(sessions.get('legacy-preset-session')).toMatchObject({
      id: 'legacy-preset-session',
      presetKey: 'codex',
      terminalMode: 'tmux',
      terminalSessionId: 'term-legacy-preset',
      terminalOutputSnapshot: 'legacy tmux output\n',
    });
  });

  it.fails('skips submitted and chat-mode sessions when restoring persisted planning tmux sessions', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-tmux', makeSession({
      id: 'submitted-tmux',
      title: 'Submitted tmux',
      status: 'submitted',
      submittedWorkflowId: 'wf-submitted',
      submittedPlanName: 'Submitted plan',
      terminalMode: 'tmux',
      terminalSessionId: 'term-submitted',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'submitted output\n',
    }));
    sessions.set('chat-with-terminal-id', makeSession({
      id: 'chat-with-terminal-id',
      title: 'Chat mode with stale terminal id',
      terminalMode: 'chat',
      terminalSessionId: 'term-chat',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'chat output\n',
    }));
    sessions.set('draft-tmux', makeSession({
      id: 'draft-tmux',
      title: 'Draft tmux',
      terminalMode: 'tmux',
      terminalSessionId: 'term-draft',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'draft output\n',
    }));

    const manager = new FakePlanningTerminalManager();
    const { restorePersistedPlanningTerminals } = bindPlanningTerminalSessionState({
      embeddedTerminalManager: manager as any,
      logger,
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo',
    });

    restorePersistedPlanningTerminals();

    expect(manager.restoreCalls).toHaveLength(1);
    expect(manager.restoreCalls[0]).toMatchObject({
      sessionId: 'term-draft',
      planningSessionId: 'draft-tmux',
      taskId: 'planning:draft-tmux',
    });
  });
});
