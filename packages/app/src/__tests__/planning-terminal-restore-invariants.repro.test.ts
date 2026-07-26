import { describe, it, expect, vi } from 'vitest';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  EmbeddedTerminalManager,
  type EmbeddedTerminalBackend,
} from '../embedded-terminal-manager.js';
import {
  bindPlanningTerminalSessionState,
  registerPlanningTerminalSessionIpcHandlers,
} from '../terminal-session-ipc.js';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSession,
  type InAppPlanningSessionStore,
} from '../in-app-planner.js';

function makePlanningRecord(
  overrides: Partial<InAppPlanningSessionRecord> = {},
): InAppPlanningSessionRecord {
  return {
    id: 'planning-restore',
    title: 'Planning restore',
    presetKey: 'codex',
    status: 'still_discussing',
    messages: [
      {
        id: 1,
        role: 'user',
        text: 'Restore this planning transcript.',
        createdAt: '2026-07-26T00:00:00.000Z',
      },
    ],
    pendingResponse: false,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:01.000Z',
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
    messages: [
      {
        id: 1,
        role: 'user',
        text: 'Open a tmux planning terminal.',
        createdAt: '2026-07-26T00:00:00.000Z',
      },
    ],
    conversation: new PlanConversation({}),
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:01.000Z',
    nextMessageId: 2,
    ...overrides,
  };
}

function makePlanningSessionStore(): InAppPlanningSessionStore {
  return {
    upsertInAppPlanningSession: vi.fn(),
    updateInAppPlanningSession: vi.fn(),
    deleteInAppPlanningSession: vi.fn(),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeBackend(): EmbeddedTerminalBackend & { spawn: ReturnType<typeof vi.fn> } {
  return {
    name: 'bash',
    spawn: vi.fn(() => ({
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
    })),
  };
}

function bindRestoreState(deps: {
  manager: EmbeddedTerminalManager;
  sessions: ReturnType<typeof createInAppPlanningChatSessions>;
  store?: InAppPlanningSessionStore;
}) {
  return bindPlanningTerminalSessionState({
    embeddedTerminalManager: deps.manager,
    logger: makeLogger(),
    planningChatSessions: deps.sessions,
    getPlanningSessionStore: () => deps.store,
    repoRoot: '/repo',
  });
}

describe('planning terminal restore invariants repro', () => {
  const planningCommandBuilder = vi.fn(() => ({ command: 'codex', args: [] }));

  // `it.fails`: current restore drops records whose preset key disappeared.
  // The fix slice should preserve the visible chat and surface a preset error.
  it.fails('keeps a restored planning chat visible when its preset was removed or remapped', async () => {
    const sessions = createInAppPlanningChatSessions();
    const removedPresetRecord = makePlanningRecord({
      id: 'removed-preset-chat',
      title: 'Removed preset chat',
      presetKey: 'removed-custom-preset',
      messages: [
        {
          id: 1,
          role: 'user',
          text: 'This transcript should not disappear just because a preset changed.',
          createdAt: '2026-07-26T00:00:00.000Z',
        },
      ],
    });

    await restorePlanningChatSessions([removedPresetRecord], {
      config: { defaultSlackHarnessPreset: 'codex' },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    const restored = sessions.get('removed-preset-chat');
    expect(restored?.messages.map((message) => message.text)).toContain(
      'This transcript should not disappear just because a preset changed.',
    );
    expect(restored?.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'system',
      tone: 'error',
      text: expect.stringContaining('preset'),
    }));
  });

  it('does not revive a stale tmux id for a submitted session restored in chat mode', () => {
    const backend = makeBackend();
    const manager = new EmbeddedTerminalManager({ backend });
    const sessions = createInAppPlanningChatSessions();
    sessions.set('submitted-chat-mode', makePlanningSession({
      id: 'submitted-chat-mode',
      status: 'submitted',
      submittedWorkflowId: 'wf-submitted',
      submittedPlanName: 'Submitted plan',
      terminalMode: 'chat',
      terminalSessionId: 'stale-tmux-session',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'old tmux output\n',
    }));

    bindRestoreState({ manager, sessions }).restorePersistedPlanningTerminals();

    expect(manager.get('stale-tmux-session')).toBeUndefined();
    expect(backend.spawn).not.toHaveBeenCalled();
  });

  it('restores a submitted tmux session for viewing but rejects write access', async () => {
    type IpcHandler = (...args: unknown[]) => Promise<unknown>;
    const handlers = new Map<string, IpcHandler>();
    const ipcMain = {
      handle(channel: string, callback: IpcHandler) {
        handlers.set(channel, callback);
      },
    };
    const backend = makeBackend();
    const manager = new EmbeddedTerminalManager({ backend });
    const sessions = createInAppPlanningChatSessions();
    const store = makePlanningSessionStore();
    sessions.set('submitted-tmux-mode', makePlanningSession({
      id: 'submitted-tmux-mode',
      status: 'submitted',
      submittedWorkflowId: 'wf-submitted',
      submittedPlanName: 'Submitted plan',
      terminalMode: 'tmux',
      terminalSessionId: 'submitted-tmux-session',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'submitted tmux output\n',
      terminalUpdatedAt: '2026-07-26T00:00:02.000Z',
    }));

    bindRestoreState({ manager, sessions, store }).restorePersistedPlanningTerminals();
    registerPlanningTerminalSessionIpcHandlers({
      ipcMain: ipcMain as any,
      embeddedTerminalManager: manager,
      logger: makeLogger(),
      planningChatSessions: sessions,
      getPlanningSessionStore: () => store,
      repoRoot: '/repo',
    });

    expect(manager.get('submitted-tmux-session')).toMatchObject({
      kind: 'planning',
      planningSessionId: 'submitted-tmux-mode',
      outputSnapshot: 'submitted tmux output\n',
    });
    await expect(
      handlers.get('invoker:planning-terminal-write')?.(
        {},
        'submitted-tmux-session',
        'echo should not write\n',
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'This planning session was already submitted.',
    });
  });
});
