import { describe, expect, it, vi } from 'vitest';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
} from '../in-app-planner.js';
import {
  bindPlanningTerminalSessionState,
} from '../terminal-session-ipc.js';
import type { EmbeddedTerminalManager } from '../embedded-terminal-manager.js';

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

function planningRecord(overrides: Partial<InAppPlanningSessionRecord> = {}): InAppPlanningSessionRecord {
  return {
    id: 'planning-restore-repro',
    title: 'Planning restore repro',
    presetKey: 'codex',
    status: 'still_discussing',
    confirmationMode: 'require',
    messages: [
      {
        id: 1,
        role: 'user',
        text: 'Keep this planning chat restorable.',
        createdAt: '2026-07-07T00:00:00.000Z',
      },
    ],
    pendingResponse: false,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    ...overrides,
  };
}

describe('planning terminal restore invariants repro', () => {
  it.fails('remaps a restored chat whose saved preset was removed to the current default preset', async () => {
    const sessions = createInAppPlanningChatSessions();

    await restorePlanningChatSessions([
      planningRecord({
        id: 'removed-preset-chat',
        presetKey: 'removed+claude',
      }),
    ], {
      config: { defaultSlackHarnessPreset: 'codex' },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(sessions.get('removed-preset-chat')).toMatchObject({
      id: 'removed-preset-chat',
      presetKey: 'codex',
      status: 'still_discussing',
    });
  });

  it.fails('does not restore planning tmux processes for submitted or chat-mode sessions', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-tmux-chat', {
      id: 'submitted-tmux-chat',
      title: 'Submitted tmux chat',
      presetKey: 'codex',
      confirmationMode: 'require',
      status: 'submitted',
      messages: [],
      conversation: {} as any,
      submittedWorkflowId: 'wf-submitted',
      submittedPlanName: 'Submitted plan',
      terminalMode: 'tmux',
      terminalSessionId: 'term-submitted',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'submitted output\n',
      terminalUpdatedAt: '2026-07-07T00:00:02.000Z',
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:03.000Z',
      nextMessageId: 1,
    });
    sessions.set('chat-mode-with-terminal-id', {
      id: 'chat-mode-with-terminal-id',
      title: 'Chat mode with stale terminal id',
      presetKey: 'codex',
      confirmationMode: 'require',
      status: 'still_discussing',
      messages: [],
      conversation: {} as any,
      terminalMode: 'chat',
      terminalSessionId: 'term-chat-mode',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'chat output\n',
      terminalUpdatedAt: '2026-07-07T00:00:02.000Z',
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:03.000Z',
      nextMessageId: 1,
    });
    const restoreSpawnSession = vi.fn();
    const embeddedTerminalManager = {
      on: vi.fn(),
      restoreSpawnSession,
    } as unknown as EmbeddedTerminalManager;

    bindPlanningTerminalSessionState({
      embeddedTerminalManager,
      logger: { info: vi.fn(), warn: vi.fn() },
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo',
    }).restorePersistedPlanningTerminals();

    expect(restoreSpawnSession).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'term-chat-mode',
    }));
    expect(restoreSpawnSession).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'term-submitted',
    }));
  });
});
