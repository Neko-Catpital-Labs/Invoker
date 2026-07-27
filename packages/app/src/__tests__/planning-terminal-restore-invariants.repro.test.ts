import { describe, expect, it, vi } from 'vitest';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  listPlanningChatSessions,
  restorePlanningChatSessions,
} from '../in-app-planner.js';
import { bindPlanningTerminalSessionState } from '../terminal-session-ipc.js';

const planningCommandBuilder = vi.fn(() => ({
  command: 'node',
  args: ['-e', 'process.stdout.write("")'],
}));

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
        role: 'assistant',
        text: 'Restored chat.',
        createdAt: '2026-07-07T00:00:01.000Z',
      },
    ],
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    pendingResponse: false,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    ...overrides,
  };
}

function planningSession(overrides: Record<string, unknown>) {
  return {
    id: 'planning-session',
    title: 'Planning session',
    presetKey: 'codex',
    status: 'still_discussing',
    messages: [],
    conversation: {} as any,
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    nextMessageId: 1,
    ...overrides,
  } as any;
}

describe('planning terminal restore invariant repros', () => {
  // Desired behavior: a saved planning chat should survive config preset
  // remapping by falling back to the current default preset instead of vanishing.
  it.fails('restores a planning chat when its saved preset key is missing or remapped', async () => {
    const sessions = createInAppPlanningChatSessions();

    await restorePlanningChatSessions([
      planningRecord({
        id: 'remapped-preset-chat',
        title: 'Remapped preset chat',
        presetKey: 'retired+planner',
        terminalMode: 'tmux',
        terminalSessionId: 'term-remapped',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'saved tmux output\n',
      }),
    ], {
      config: { defaultSlackHarnessPreset: 'codex' },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(listPlanningChatSessions({ sessions }).sessions).toEqual([
      expect.objectContaining({
        id: 'remapped-preset-chat',
        presetKey: 'codex',
        terminalMode: 'tmux',
        terminalSessionId: 'term-remapped',
        terminalStatus: 'running',
      }),
    ]);
  });

  // Desired behavior: startup tmux restore only revives editable tmux-mode chats.
  // Submitted chats are read-only, and chat-mode records may only retain history.
  it.fails('does not revive submitted or chat-mode planning tmux sessions on startup', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-tmux', planningSession({
      id: 'submitted-tmux',
      status: 'submitted',
      submittedWorkflowId: 'wf-submitted',
      submittedPlanName: 'Submitted plan',
      terminalMode: 'tmux',
      terminalSessionId: 'term-submitted',
      terminalStatus: 'running',
    }));
    sessions.set('chat-mode-with-stale-terminal', planningSession({
      id: 'chat-mode-with-stale-terminal',
      terminalMode: 'chat',
      terminalSessionId: 'term-chat-stale',
      terminalStatus: 'running',
    }));

    const restoreSpawnSession = vi.fn();
    const planningTerminalState = bindPlanningTerminalSessionState({
      embeddedTerminalManager: {
        on: vi.fn(),
        restoreSpawnSession,
      } as any,
      logger: { info: vi.fn(), warn: vi.fn() },
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo',
    });

    planningTerminalState.restorePersistedPlanningTerminals();

    expect(restoreSpawnSession).not.toHaveBeenCalled();
  });
});
