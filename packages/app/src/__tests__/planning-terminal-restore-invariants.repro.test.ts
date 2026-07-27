import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import {
  bindPlanningTerminalSessionState,
} from '../terminal-session-ipc.js';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSession,
} from '../in-app-planner.js';

const now = '2026-07-26T00:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
});

function planningRecord(overrides: Partial<InAppPlanningSessionRecord>): InAppPlanningSessionRecord {
  return {
    id: 'session-1',
    title: 'Planning session',
    presetKey: 'codex',
    status: 'still_discussing',
    messages: [],
    pendingResponse: false,
    createdAt: now,
    updatedAt: now,
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    ...overrides,
  };
}

function planningSession(overrides: Partial<InAppPlanningChatSession>): InAppPlanningChatSession {
  return {
    id: 'session-1',
    title: 'Planning session',
    presetKey: 'codex',
    status: 'still_discussing',
    messages: [],
    conversation: {} as InAppPlanningChatSession['conversation'],
    createdAt: now,
    updatedAt: now,
    nextMessageId: 1,
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    ...overrides,
  };
}

describe('planning-terminal restore invariants repro', () => {
  it('skips missing presets while restoring remapped/custom preset sessions with terminal state intact', async () => {
    const init = vi.spyOn(PlanConversation.prototype, 'init').mockResolvedValue(undefined);
    const sessions = createInAppPlanningChatSessions();

    await restorePlanningChatSessions([
      planningRecord({
        id: 'removed-preset-chat',
        presetKey: 'removed-preset',
        title: 'Removed preset chat',
      }),
      planningRecord({
        id: 'remapped-preset-chat',
        presetKey: 'legacy-remapped',
        title: 'Remapped preset chat',
        terminalMode: 'tmux',
        terminalSessionId: 'term-remapped',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'restored output',
      }),
    ], {
      config: {
        slackHarnessPresets: {
          'legacy-remapped': { tool: 'codex' },
        },
      },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder: vi.fn(() => ({ command: 'planner', args: [] })),
    });

    expect(init).toHaveBeenCalledTimes(1);
    expect(sessions.has('removed-preset-chat')).toBe(false);
    expect(sessions.get('remapped-preset-chat')).toMatchObject({
      id: 'remapped-preset-chat',
      presetKey: 'legacy-remapped',
      terminalMode: 'tmux',
      terminalSessionId: 'term-remapped',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'restored output',
    });
  });

  // `it.fails`: this asserts the desired tmux restore invariant. Startup should
  // not resurrect submitted planning tmux sessions, and chat-mode records remain
  // chat-only even if stale terminal ids are present.
  it.fails('does not restore submitted or chat-mode planning tmux sessions on startup', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-tmux', planningSession({
      id: 'submitted-tmux',
      status: 'submitted',
      submittedWorkflowId: 'wf-submitted',
      submittedPlanName: 'Submitted Plan',
      terminalMode: 'tmux',
      terminalSessionId: 'term-submitted',
      terminalStatus: 'running',
    }));
    sessions.set('chat-with-stale-terminal', planningSession({
      id: 'chat-with-stale-terminal',
      terminalMode: 'chat',
      terminalSessionId: 'term-chat-stale',
      terminalStatus: 'running',
    }));
    sessions.set('active-tmux', planningSession({
      id: 'active-tmux',
      terminalMode: 'tmux',
      terminalSessionId: 'term-active',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'active output',
    }));

    const restoreSpawnSession = vi.fn();
    const binding = bindPlanningTerminalSessionState({
      embeddedTerminalManager: {
        on: vi.fn(),
        restoreSpawnSession,
      } as any,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo',
    });

    binding.restorePersistedPlanningTerminals();

    expect(restoreSpawnSession).toHaveBeenCalledTimes(1);
    expect(restoreSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'term-active',
      taskId: 'planning:active-tmux',
      kind: 'planning',
      planningSessionId: 'active-tmux',
      outputSnapshot: 'active output',
    }));
  });
});
