import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { TerminalSessionDescriptor } from '@invoker/contracts';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSession,
  type InAppPlanningSessionStore,
} from '../in-app-planner.js';
import {
  bindPlanningTerminalSessionState,
  registerPlanningTerminalSessionIpcHandlers,
} from '../terminal-session-ipc.js';
import type { EmbeddedTerminalManager } from '../embedded-terminal-manager.js';

const NOW = '2026-07-07T00:00:00.000Z';

function makePlanningRecord(
  overrides: Partial<InAppPlanningSessionRecord> = {},
): InAppPlanningSessionRecord {
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

function makePlanningSession(
  overrides: Partial<InAppPlanningChatSession> = {},
): InAppPlanningChatSession {
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

function makePlanningStore(): InAppPlanningSessionStore {
  return {
    upsertInAppPlanningSession: vi.fn(),
    updateInAppPlanningSession: vi.fn(),
    deleteInAppPlanningSession: vi.fn(),
  };
}

function makeTerminalDescriptor(overrides: Partial<TerminalSessionDescriptor> = {}): TerminalSessionDescriptor {
  return {
    sessionId: 'term-planning-session',
    taskId: 'planning:planning-session',
    kind: 'planning',
    planningSessionId: 'planning-session',
    status: 'running',
    mode: 'spawn',
    attached: false,
    createdAt: NOW,
    outputSnapshot: '',
    ...overrides,
  };
}

describe('planning terminal restore invariants repro', () => {
  it('skips a missing saved preset while preserving a remapped non-default planning terminal preset', async () => {
    const sessions = createInAppPlanningChatSessions();
    const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

    await restorePlanningChatSessions([
      makePlanningRecord({
        id: 'removed-custom-preset',
        title: 'Removed custom preset',
        presetKey: 'custom-that-no-longer-exists',
        terminalMode: 'tmux',
        terminalSessionId: 'term-removed-custom',
        terminalStatus: 'running',
      }),
      makePlanningRecord({
        id: 'codex-persists-through-default-remap',
        title: 'Codex persisted through default remap',
        presetKey: 'codex',
        terminalMode: 'tmux',
        terminalSessionId: 'term-codex-remapped-default',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'saved tmux output\n',
      }),
    ], {
      config: { defaultSlackHarnessPreset: 'omp+claude' },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
      conversationRepo: { loadConversation: () => null } as any,
    });

    expect(sessions.has('removed-custom-preset')).toBe(false);
    expect(sessions.get('codex-persists-through-default-remap')).toMatchObject({
      presetKey: 'codex',
      terminalMode: 'tmux',
      terminalSessionId: 'term-codex-remapped-default',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'saved tmux output\n',
    });
  });

  it('reproduces submitted tmux restore while skipping chat-mode terminal ids and blocking writes', async () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-tmux', makePlanningSession({
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
    sessions.set('chat-mode-with-terminal-id', makePlanningSession({
      id: 'chat-mode-with-terminal-id',
      title: 'Chat mode with terminal id',
      terminalMode: 'chat',
      terminalSessionId: 'term-chat-mode',
      terminalStatus: 'running',
    }));
    sessions.set('exited-tmux', makePlanningSession({
      id: 'exited-tmux',
      title: 'Exited tmux',
      terminalMode: 'tmux',
      terminalSessionId: 'term-exited',
      terminalStatus: 'exited',
    }));

    const submittedTerminal = makeTerminalDescriptor({
      sessionId: 'term-submitted',
      taskId: 'planning:submitted-tmux',
      planningSessionId: 'submitted-tmux',
      outputSnapshot: 'submitted output\n',
    });
    const restoreSpawnSession = vi.fn(() => submittedTerminal);
    const manager = {
      on: vi.fn(),
      restoreSpawnSession,
      get: vi.fn((sessionId: string) => (sessionId === 'term-submitted' ? submittedTerminal : undefined)),
      openOrReuse: vi.fn(),
      list: vi.fn(() => [submittedTerminal]),
      write: vi.fn(() => ({ ok: true })),
      resize: vi.fn(() => ({ ok: true })),
      close: vi.fn(() => ({ ok: true })),
    } as unknown as EmbeddedTerminalManager;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const store = makePlanningStore();

    const { restorePersistedPlanningTerminals } = bindPlanningTerminalSessionState({
      embeddedTerminalManager: manager,
      logger,
      planningChatSessions: sessions,
      getPlanningSessionStore: () => store,
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

    type IpcHandler = (_event: unknown, ...args: any[]) => Promise<any> | any;
    const handlers = new Map<string, IpcHandler>();
    const ipcMain = {
      handle(channel: string, callback: IpcHandler) {
        handlers.set(channel, callback);
      },
    };
    registerPlanningTerminalSessionIpcHandlers({
      ipcMain: ipcMain as unknown as IpcMain,
      embeddedTerminalManager: manager,
      logger,
      planningChatSessions: sessions,
      getPlanningSessionStore: () => store,
      repoRoot: '/repo',
    });

    await expect(handlers.get('invoker:planning-terminal-open')?.({}, 'submitted-tmux')).resolves.toEqual({
      opened: false,
      reason: 'This planning session was already submitted.',
    });
    await expect(handlers.get('invoker:planning-terminal-write')?.({}, 'term-submitted', 'x')).resolves.toEqual({
      ok: false,
      reason: 'This planning session was already submitted.',
    });
    expect((manager as unknown as { write: ReturnType<typeof vi.fn> }).write).not.toHaveBeenCalled();
  });
});
