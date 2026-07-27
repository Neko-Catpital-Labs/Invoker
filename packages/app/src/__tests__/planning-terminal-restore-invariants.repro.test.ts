import { describe, it, expect, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSessions,
  type InAppPlanningSessionStore,
} from '../in-app-planner.js';
import {
  bindPlanningTerminalSessionState,
  registerPlanningTerminalSessionIpcHandlers,
} from '../terminal-session-ipc.js';

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

function planningRecord(overrides: Partial<InAppPlanningSessionRecord> = {}): InAppPlanningSessionRecord {
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

function makeStore(): InAppPlanningSessionStore & {
  updates: Array<{ sessionId: string; patch: unknown }>;
} {
  const updates: Array<{ sessionId: string; patch: unknown }> = [];
  return {
    updates,
    upsertInAppPlanningSession: vi.fn(),
    updateInAppPlanningSession: vi.fn((sessionId: string, patch: unknown) => {
      updates.push({ sessionId, patch });
    }),
    deleteInAppPlanningSession: vi.fn(),
  };
}

function makePlanningTerminalManager() {
  const liveSessions = new Map<string, any>();
  const listeners = new Map<string, Array<(record: any) => void>>();
  return {
    on: vi.fn((event: string, callback: (record: any) => void) => {
      const callbacks = listeners.get(event) ?? [];
      callbacks.push(callback);
      listeners.set(event, callbacks);
    }),
    restoreSpawnSession: vi.fn((record: any) => {
      const session = {
        sessionId: record.sessionId,
        taskId: record.taskId,
        kind: record.kind,
        planningSessionId: record.planningSessionId,
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: record.createdAt,
        outputSnapshot: record.outputSnapshot,
      };
      liveSessions.set(record.sessionId, session);
      return session;
    }),
    openOrReuse: vi.fn(),
    list: vi.fn(() => [...liveSessions.values()]),
    get: vi.fn((sessionId: string) => liveSessions.get(sessionId)),
    write: vi.fn(() => ({ ok: true })),
    resize: vi.fn(() => ({ ok: true })),
    close: vi.fn(() => ({ ok: true })),
    liveSessions,
  };
}

describe('planning terminal restore invariants repro', () => {
  it.fails('remaps a persisted planning chat with a missing preset instead of dropping the conversation', async () => {
    const sessions = createInAppPlanningChatSessions();
    const store = makeStore();

    await restorePlanningChatSessions([
      planningRecord({
        id: 'planning-legacy-preset',
        title: 'Legacy preset chat',
        presetKey: 'legacy-codex',
      }),
    ], {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
      planningSessionStore: store,
    });

    expect(sessions.get('planning-legacy-preset')).toMatchObject({
      id: 'planning-legacy-preset',
      presetKey: 'codex',
      title: 'Legacy preset chat',
    });
    expect(store.updateInAppPlanningSession).toHaveBeenCalledWith(
      'planning-legacy-preset',
      expect.objectContaining({ presetKey: 'codex' }),
    );
  });

  it.fails('restores a submitted planning tmux session even when the saved terminal mode is chat', () => {
    const sessions: InAppPlanningChatSessions = createInAppPlanningChatSessions();
    sessions.set('planning-submitted-chat-mode', {
      id: 'planning-submitted-chat-mode',
      title: 'Submitted with tmux',
      presetKey: 'codex',
      confirmationMode: 'require',
      status: 'submitted',
      messages: [],
      conversation: {} as any,
      submittedPlanName: 'Submitted with tmux',
      submittedWorkflowId: 'wf-submitted',
      terminalMode: 'chat',
      terminalSessionId: 'tmux-submitted-chat-mode',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'submitted tmux output\n',
      terminalUpdatedAt: '2026-07-07T00:00:03.000Z',
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:04.000Z',
      nextMessageId: 1,
    });
    const manager = makePlanningTerminalManager();
    const store = makeStore();

    const { restorePersistedPlanningTerminals } = bindPlanningTerminalSessionState({
      embeddedTerminalManager: manager as any,
      logger: { warn: vi.fn(), info: vi.fn() },
      planningChatSessions: sessions,
      getPlanningSessionStore: () => store,
      repoRoot: '/repo',
    });

    restorePersistedPlanningTerminals();

    expect(manager.restoreSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'tmux-submitted-chat-mode',
      taskId: 'planning:planning-submitted-chat-mode',
      kind: 'planning',
      planningSessionId: 'planning-submitted-chat-mode',
      outputSnapshot: 'submitted tmux output\n',
    }));

    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    registerPlanningTerminalSessionIpcHandlers({
      ipcMain: {
        handle(channel: string, callback: (...args: unknown[]) => Promise<unknown>) {
          handlers.set(channel, callback);
        },
      } as unknown as IpcMain,
      embeddedTerminalManager: manager as any,
      logger: { warn: vi.fn(), info: vi.fn() },
      planningChatSessions: sessions,
      getPlanningSessionStore: () => store,
      repoRoot: '/repo',
    });

    return expect(
      handlers.get('invoker:planning-terminal-write')?.({}, 'tmux-submitted-chat-mode', 'x'),
    ).resolves.toEqual({
      ok: false,
      reason: 'This planning session was already submitted.',
    });
  });
});
