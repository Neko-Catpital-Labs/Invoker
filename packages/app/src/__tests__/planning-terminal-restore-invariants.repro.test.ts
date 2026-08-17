import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  bindPlanningTerminalSessionState,
} from '../terminal-session-ipc.js';
import {
  createInAppPlanningChatSessions,
  createPlanningCommandBuilderFromRegistry,
  listPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSession,
} from '../in-app-planner.js';
import type { EmbeddedTerminalManager } from '../embedded-terminal-manager.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const planningCommandBuilder = createPlanningCommandBuilderFromRegistry({
  getPlanningOrThrow: vi.fn(() => ({
    buildPlanningCommand: vi.fn(() => ({ command: 'planner', args: [] })),
  })),
});

function makeRecord(
  id: string,
  overrides: Partial<InAppPlanningSessionRecord> = {},
): InAppPlanningSessionRecord {
  return {
    id,
    title: `Planning ${id}`,
    presetKey: 'codex',
    confirmationMode: 'require',
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
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

function makeSession(
  id: string,
  overrides: Partial<InAppPlanningChatSession> = {},
): InAppPlanningChatSession {
  return {
    id,
    title: `Planning ${id}`,
    presetKey: 'codex',
    confirmationMode: 'require',
    status: 'still_discussing',
    messages: [],
    conversation: {} as InAppPlanningChatSession['conversation'],
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    nextMessageId: 1,
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    ...overrides,
  };
}

describe('planning terminal restore invariants repro', () => {
  // Expected-failing proof: a persisted planning chat should survive preset
  // removal by rebinding to the configured default, while explicitly remapped
  // presets still restore under their persisted key.
  it.fails('restores missing and remapped persisted presets without dropping planning chats', async () => {
    const sessions = createInAppPlanningChatSessions();
    await restorePlanningChatSessions([
      makeRecord('remapped-preset', { presetKey: 'legacy-codex' }),
      makeRecord('missing-preset', { presetKey: 'removed-agent' }),
    ], {
      config: {
        defaultSlackHarnessPreset: 'codex',
        slackHarnessPresets: {
          'legacy-codex': { tool: 'codex' },
        },
      },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(sessions.get('remapped-preset')?.presetKey).toBe('legacy-codex');
    expect(sessions.get('missing-preset')).toMatchObject({
      id: 'missing-preset',
      presetKey: 'codex',
      status: 'still_discussing',
    });
    expect(listPlanningChatSessions({ sessions, config: {} }).sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining(['remapped-preset', 'missing-preset']),
    );
  });

  // Expected-failing proof: owner restart must not resurrect an interactive tmux
  // process for a submitted planning chat. Chat-mode rows with stale terminal ids
  // should also stay inert.
  it.fails('does not restore tmux processes for submitted or chat-mode planning sessions', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-tmux', makeSession('submitted-tmux', {
      status: 'submitted',
      submittedPlanName: 'Submitted plan',
      submittedWorkflowId: 'wf-submitted',
      terminalMode: 'tmux',
      terminalSessionId: 'terminal-submitted',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'submitted shell output\n',
    }));
    sessions.set('chat-mode-stale-terminal', makeSession('chat-mode-stale-terminal', {
      terminalMode: 'chat',
      terminalSessionId: 'terminal-stale-chat-mode',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'stale shell output\n',
    }));
    sessions.set('active-tmux', makeSession('active-tmux', {
      terminalMode: 'tmux',
      terminalSessionId: 'terminal-active',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'active shell output\n',
    }));
    const restoreSpawnSession = vi.fn();
    const embeddedTerminalManager = Object.assign(new EventEmitter(), {
      restoreSpawnSession,
    }) as unknown as EmbeddedTerminalManager;

    const { restorePersistedPlanningTerminals } = bindPlanningTerminalSessionState({
      embeddedTerminalManager,
      logger: { info: vi.fn(), warn: vi.fn() },
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo',
    });

    restorePersistedPlanningTerminals();

    expect(restoreSpawnSession).toHaveBeenCalledTimes(1);
    expect(restoreSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'terminal-active',
      planningSessionId: 'active-tmux',
      taskId: 'planning:active-tmux',
      outputSnapshot: 'active shell output\n',
    }));
  });
});
