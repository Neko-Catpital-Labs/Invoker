import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import { type InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
} from '../in-app-planner.js';
import { bindPlanningTerminalSessionState } from '../terminal-session-ipc.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

function planningRecord(
  overrides: Partial<InAppPlanningSessionRecord> = {},
): InAppPlanningSessionRecord {
  return {
    id: 'planning-record',
    title: 'Planning record',
    presetKey: 'codex',
    status: 'still_discussing',
    confirmationMode: 'require',
    messages: [
      {
        id: 1,
        role: 'system',
        text: 'Ask Invoker what you want to build.',
        tone: 'muted',
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
  it('reproduces missing or remapped preset restore dropping the saved planning session', async () => {
    const initConversation = vi.spyOn(PlanConversation.prototype, 'init').mockResolvedValue(undefined);
    const sessions = createInAppPlanningChatSessions();

    await restorePlanningChatSessions([
      planningRecord({
        id: 'retired-preset-session',
        title: 'Retired preset session',
        presetKey: 'retired-custom-preset',
        terminalMode: 'tmux',
        terminalSessionId: 'term-retired-preset',
        terminalStatus: 'running',
      }),
    ], {
      config: {
        defaultSlackHarnessPreset: 'renamed-custom-preset',
        slackHarnessPresets: {
          'renamed-custom-preset': { tool: 'codex' },
        },
      },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(sessions.has('retired-preset-session')).toBe(false);
    expect(initConversation).not.toHaveBeenCalled();
  });

  it('reproduces submitted tmux restore while chat-mode terminal state is skipped', async () => {
    vi.spyOn(PlanConversation.prototype, 'init').mockResolvedValue(undefined);
    const sessions = createInAppPlanningChatSessions();
    await restorePlanningChatSessions([
      planningRecord({
        id: 'submitted-tmux-session',
        title: 'Submitted tmux session',
        status: 'submitted',
        submittedWorkflowId: 'wf-submitted',
        submittedPlanName: 'Submitted plan',
        terminalMode: 'tmux',
        terminalSessionId: 'term-submitted-tmux',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'submitted terminal output\n',
        terminalUpdatedAt: '2026-07-07T00:00:02.000Z',
      }),
      planningRecord({
        id: 'chat-mode-with-stale-terminal',
        title: 'Chat mode with stale terminal',
        status: 'still_discussing',
        terminalMode: 'chat',
        terminalSessionId: 'term-chat-mode-stale',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'chat mode stale output\n',
      }),
    ], {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    const restoreSpawnSession = vi.fn();
    const embeddedTerminalManager = {
      on: vi.fn(),
      restoreSpawnSession,
    };

    const { restorePersistedPlanningTerminals } = bindPlanningTerminalSessionState({
      embeddedTerminalManager: embeddedTerminalManager as any,
      logger: { info: vi.fn(), warn: vi.fn() },
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo',
    });

    restorePersistedPlanningTerminals();

    expect(restoreSpawnSession).toHaveBeenCalledTimes(1);
    expect(restoreSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'term-submitted-tmux',
      taskId: 'planning:submitted-tmux-session',
      kind: 'planning',
      planningSessionId: 'submitted-tmux-session',
      cwd: '/repo',
      outputSnapshot: 'submitted terminal output\n',
    }));
    expect(restoreSpawnSession).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'term-chat-mode-stale',
    }));
  });
});
