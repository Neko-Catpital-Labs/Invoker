import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSession,
} from '../in-app-planner.js';
import { bindPlanningTerminalSessionState } from '../terminal-session-ipc.js';
import type { EmbeddedTerminalManager } from '../embedded-terminal-manager.js';

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

function makeRecord(overrides: Partial<InAppPlanningSessionRecord> = {}): InAppPlanningSessionRecord {
  return {
    id: 'planning-record',
    title: 'Planning record',
    presetKey: 'codex',
    status: 'still_discussing',
    confirmationMode: 'require',
    messages: [
      {
        id: 1,
        role: 'assistant',
        text: 'Restored transcript.',
        createdAt: '2026-07-07T00:00:01.000Z',
      },
    ],
    pendingResponse: false,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    ...overrides,
  };
}

function makeSession(overrides: Partial<InAppPlanningChatSession> = {}): InAppPlanningChatSession {
  const now = '2026-07-07T00:00:00.000Z';
  return {
    id: 'planning-session',
    title: 'Planning session',
    presetKey: 'codex',
    confirmationMode: 'require',
    status: 'still_discussing',
    messages: [],
    conversation: {} as any,
    createdAt: now,
    updatedAt: now,
    nextMessageId: 1,
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    ...overrides,
  };
}

describe('planning terminal restore invariants repro', () => {
  it('reproduces dropping a restored chat when its preset key was removed or remapped', async () => {
    const sessions = createInAppPlanningChatSessions();

    await restorePlanningChatSessions([
      makeRecord({
        id: 'old-custom-preset-chat',
        title: 'Old custom preset chat',
        presetKey: 'old-custom-preset',
      }),
    ], {
      config: {
        defaultSlackHarnessPreset: 'codex',
        slackHarnessPresets: {
          'new-custom-preset': { tool: 'codex' },
        },
      },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(sessions.has('old-custom-preset-chat')).toBe(false);
    expect([...sessions.keys()]).toEqual([]);
  });

  it('reproduces submitted tmux sessions being restored while chat-mode sessions are skipped', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-tmux', makeSession({
      id: 'submitted-tmux',
      status: 'submitted',
      submittedWorkflowId: 'wf-submitted',
      submittedPlanName: 'Submitted plan',
      terminalMode: 'tmux',
      terminalSessionId: 'term-submitted',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'submitted output\n',
      terminalUpdatedAt: '2026-07-07T00:00:03.000Z',
    }));
    sessions.set('chat-mode-with-terminal', makeSession({
      id: 'chat-mode-with-terminal',
      terminalMode: 'chat',
      terminalSessionId: 'term-chat-mode',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'chat mode output\n',
      terminalUpdatedAt: '2026-07-07T00:00:04.000Z',
    }));

    const restoreSpawnSession = vi.fn();
    const embeddedTerminalManager = Object.assign(new EventEmitter(), {
      restoreSpawnSession,
    }) as unknown as EmbeddedTerminalManager;
    const logger = { info: vi.fn(), warn: vi.fn() };

    const { restorePersistedPlanningTerminals } = bindPlanningTerminalSessionState({
      embeddedTerminalManager,
      logger,
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo',
    });

    restorePersistedPlanningTerminals();

    expect(restoreSpawnSession).toHaveBeenCalledTimes(1);
    expect(restoreSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'term-submitted',
      taskId: 'planning:submitted-tmux',
      kind: 'planning',
      planningSessionId: 'submitted-tmux',
      cwd: '/repo',
      outputSnapshot: 'submitted output\n',
    }));
    expect(restoreSpawnSession).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'term-chat-mode',
    }));
  });
});
