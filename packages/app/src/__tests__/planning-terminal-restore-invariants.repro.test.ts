import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSession,
} from '../in-app-planner.js';
import {
  bindPlanningTerminalSessionState,
  registerPlanningTerminalSessionIpcHandlers,
} from '../terminal-session-ipc.js';

const NOW = '2026-07-26T00:00:00.000Z';

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

function makeRecord(overrides: Partial<InAppPlanningSessionRecord>): InAppPlanningSessionRecord {
  return {
    id: 'planning-record',
    title: 'Planning record',
    presetKey: 'codex',
    status: 'still_discussing',
    messages: [],
    pendingResponse: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSession(overrides: Partial<InAppPlanningChatSession>): InAppPlanningChatSession {
  return {
    id: 'planning-session',
    title: 'Planning session',
    presetKey: 'codex',
    status: 'still_discussing',
    messages: [],
    conversation: {} as InAppPlanningChatSession['conversation'],
    createdAt: NOW,
    updatedAt: NOW,
    nextMessageId: 1,
    ...overrides,
  };
}

describe('planning terminal restore invariant repros', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reproduces missing/remapped preset restore behavior', async () => {
    const sessions = createInAppPlanningChatSessions();

    await restorePlanningChatSessions([
      makeRecord({
        id: 'missing-preset-plan',
        title: 'Missing preset plan',
        presetKey: 'retired+agent',
        terminalMode: 'tmux',
        terminalSessionId: 'term-missing-preset',
        terminalStatus: 'running',
      }),
      makeRecord({
        id: 'remapped-preset-plan',
        title: 'Remapped preset plan',
        presetKey: 'legacy-codex',
        terminalMode: 'tmux',
        terminalSessionId: 'term-remapped-preset',
        terminalStatus: 'running',
      }),
    ], {
      config: {
        slackHarnessPresets: {
          'legacy-codex': { tool: 'codex' },
        },
      },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(sessions.has('missing-preset-plan')).toBe(false);
    expect(sessions.get('remapped-preset-plan')).toMatchObject({
      id: 'remapped-preset-plan',
      presetKey: 'legacy-codex',
      terminalMode: 'tmux',
      terminalSessionId: 'term-remapped-preset',
      terminalStatus: 'running',
    });
  });

  it('reproduces submitted tmux restore while chat-mode terminal ids stay dormant', async () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-tmux-plan', makeSession({
      id: 'submitted-tmux-plan',
      status: 'submitted',
      terminalMode: 'tmux',
      terminalSessionId: 'term-submitted',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'submitted output\n',
      terminalUpdatedAt: '2026-07-26T00:01:00.000Z',
    }));
    sessions.set('chat-mode-with-terminal-id', makeSession({
      id: 'chat-mode-with-terminal-id',
      terminalMode: 'chat',
      terminalSessionId: 'term-chat-mode',
      terminalStatus: 'running',
    }));

    const embeddedTerminalManager = {
      on: vi.fn(),
      restoreSpawnSession: vi.fn((seed: any) => ({
        sessionId: seed.sessionId,
        taskId: seed.taskId,
        kind: seed.kind,
        planningSessionId: seed.planningSessionId,
        status: 'running',
        cwd: seed.cwd,
        mode: 'spawn',
        attached: false,
        createdAt: seed.createdAt,
        outputSnapshot: seed.outputSnapshot,
      })),
    };
    const { restorePersistedPlanningTerminals } = bindPlanningTerminalSessionState({
      embeddedTerminalManager: embeddedTerminalManager as any,
      logger: { warn: vi.fn() },
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo',
    });

    restorePersistedPlanningTerminals();

    expect(embeddedTerminalManager.restoreSpawnSession).toHaveBeenCalledTimes(1);
    expect(embeddedTerminalManager.restoreSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'term-submitted',
      taskId: 'planning:submitted-tmux-plan',
      kind: 'planning',
      planningSessionId: 'submitted-tmux-plan',
      spec: { cwd: '/repo' },
      cwd: '/repo',
      outputSnapshot: 'submitted output\n',
    }));

    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
    registerPlanningTerminalSessionIpcHandlers({
      ipcMain: {
        handle(channel: string, callback: (...args: any[]) => Promise<unknown>) {
          handlers.set(channel, callback);
        },
      } as unknown as IpcMain,
      embeddedTerminalManager: {
        on: vi.fn(),
        get: vi.fn(() => ({
          sessionId: 'term-submitted',
          taskId: 'planning:submitted-tmux-plan',
          kind: 'planning',
          planningSessionId: 'submitted-tmux-plan',
          status: 'running',
          mode: 'spawn',
          attached: false,
          createdAt: NOW,
        })),
        write: vi.fn(),
        resize: vi.fn(),
        close: vi.fn(),
        list: vi.fn(() => []),
        openOrReuse: vi.fn(),
      } as any,
      logger: { info: vi.fn(), warn: vi.fn() },
      planningChatSessions: sessions,
      getPlanningSessionStore: () => ({} as any),
      repoRoot: '/repo',
    });

    await expect(
      handlers.get('invoker:planning-terminal-write')?.({}, 'term-submitted', 'x'),
    ).resolves.toEqual({ ok: false, reason: 'This planning session was already submitted.' });
  });
});
