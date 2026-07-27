import { describe, it, expect, vi } from 'vitest';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSession,
} from '../in-app-planner.js';
import { bindPlanningTerminalSessionState } from '../terminal-session-ipc.js';
import type { EmbeddedTerminalManager } from '../embedded-terminal-manager.js';

const planningCommandBuilder = () => ({ command: 'planner', args: ['prompt'] });

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
        role: 'assistant',
        text: 'restored message',
        createdAt: '2026-07-07T00:00:01.000Z',
      },
    ],
    pendingResponse: false,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    ...overrides,
  };
}

function planningSession(overrides: Partial<InAppPlanningChatSession> = {}): InAppPlanningChatSession {
  const createdAt = '2026-07-07T00:00:00.000Z';
  return {
    id: 'plan-session',
    title: 'Plan session',
    presetKey: 'codex',
    confirmationMode: 'require',
    status: 'still_discussing',
    messages: [],
    conversation: {} as InAppPlanningChatSession['conversation'],
    createdAt,
    updatedAt: createdAt,
    nextMessageId: 1,
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    ...overrides,
  };
}

describe('planning terminal restore invariant repros', () => {
  it('reproduces dropping a restored chat when its saved preset key was removed or remapped', async () => {
    const sessions = createInAppPlanningChatSessions();

    await restorePlanningChatSessions([
      planningRecord({
        id: 'legacy-remapped-preset',
        title: 'Legacy remapped preset',
        presetKey: 'legacy-codex',
      }),
    ], {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(sessions.has('legacy-remapped-preset')).toBe(false);
    expect(sessions.size).toBe(0);
  });

  it('reproduces submitted tmux restore while a chat-mode terminal id is skipped', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-tmux', planningSession({
      id: 'submitted-tmux',
      title: 'Submitted tmux',
      status: 'submitted',
      submittedWorkflowId: 'wf-submitted',
      submittedPlanName: 'Submitted plan',
      terminalMode: 'tmux',
      terminalSessionId: 'term-submitted',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'submitted terminal output\n',
      terminalUpdatedAt: '2026-07-07T00:00:02.000Z',
      updatedAt: '2026-07-07T00:00:02.000Z',
    }));
    sessions.set('chat-mode-with-terminal', planningSession({
      id: 'chat-mode-with-terminal',
      title: 'Chat mode with terminal',
      terminalMode: 'chat',
      terminalSessionId: 'term-chat-mode',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'chat-mode terminal output\n',
      terminalUpdatedAt: '2026-07-07T00:00:03.000Z',
      updatedAt: '2026-07-07T00:00:03.000Z',
    }));

    const restoreSpawnSession = vi.fn();
    const embeddedTerminalManager = {
      on: vi.fn(),
      restoreSpawnSession,
    } as unknown as EmbeddedTerminalManager;
    const logger = { info: vi.fn(), warn: vi.fn() };

    bindPlanningTerminalSessionState({
      embeddedTerminalManager,
      logger,
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo/root',
    }).restorePersistedPlanningTerminals();

    expect(restoreSpawnSession).toHaveBeenCalledTimes(1);
    expect(restoreSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'term-submitted',
      taskId: 'planning:submitted-tmux',
      kind: 'planning',
      planningSessionId: 'submitted-tmux',
      cwd: '/repo/root',
      outputSnapshot: 'submitted terminal output\n',
    }));
    expect(restoreSpawnSession).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'term-chat-mode',
    }));
  });
});
