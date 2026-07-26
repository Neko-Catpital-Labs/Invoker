import { describe, it, expect, vi } from 'vitest';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import {
  createInAppPlanningChatSessions,
  restorePlanningChatSessions,
  type InAppPlanningChatSession,
} from '../in-app-planner.js';
import { bindPlanningTerminalSessionState } from '../terminal-session-ipc.js';

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: [] }));

function makePlanningRecord(
  overrides: Partial<InAppPlanningSessionRecord> = {},
): InAppPlanningSessionRecord {
  return {
    id: 'planning-restore-1',
    title: 'Restored planning chat',
    presetKey: 'codex',
    status: 'still_discussing',
    messages: [
      {
        id: 1,
        role: 'assistant',
        text: 'Keep this restored chat visible',
        createdAt: '2026-07-07T00:00:00.000Z',
      },
    ],
    pendingResponse: false,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    ...overrides,
  };
}

function makePlanningSession(
  overrides: Partial<InAppPlanningChatSession> = {},
): InAppPlanningChatSession {
  return {
    id: 'planning-session-1',
    title: 'Planning session',
    presetKey: 'codex',
    status: 'still_discussing',
    messages: [],
    conversation: new PlanConversation({}),
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    nextMessageId: 1,
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    ...overrides,
  };
}

function bindRestoreHarness(sessions: ReturnType<typeof createInAppPlanningChatSessions>) {
  const restoreSpawnSession = vi.fn();
  const updateInAppPlanningSession = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const bound = bindPlanningTerminalSessionState({
    embeddedTerminalManager: {
      on: vi.fn(),
      restoreSpawnSession,
    } as any,
    logger,
    planningChatSessions: sessions,
    getPlanningSessionStore: () => ({
      updateInAppPlanningSession,
      upsertInAppPlanningSession: vi.fn(),
      deleteInAppPlanningSession: vi.fn(),
    }),
    repoRoot: '/repo',
  });

  return { ...bound, restoreSpawnSession, updateInAppPlanningSession, logger };
}

describe('planning terminal restore invariants repro', () => {
  // `it.fails`: desired invariant for the behavior slice. A removed or renamed
  // custom preset should not make a persisted planning chat disappear.
  it.fails('does not drop a restored planning chat whose saved preset key is missing', async () => {
    const sessions = createInAppPlanningChatSessions();

    await restorePlanningChatSessions([
      makePlanningRecord({
        id: 'planning-missing-preset',
        presetKey: 'team-preset-that-was-removed',
      }),
    ], {
      config: { defaultSlackHarnessPreset: 'codex' },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(sessions.get('planning-missing-preset')).toMatchObject({
      id: 'planning-missing-preset',
      messages: [
        expect.objectContaining({ text: 'Keep this restored chat visible' }),
      ],
    });
  });

  it('does not restore a tmux process for a chat-mode planning session with stale terminal metadata', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('planning-chat-mode', makePlanningSession({
      id: 'planning-chat-mode',
      terminalMode: 'chat',
      terminalSessionId: 'stale-terminal-id',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'old output',
    }));
    const { restorePersistedPlanningTerminals, restoreSpawnSession } = bindRestoreHarness(sessions);

    restorePersistedPlanningTerminals();

    expect(restoreSpawnSession).not.toHaveBeenCalled();
  });

  // `it.fails`: desired invariant for the behavior slice. Submitted planning
  // sessions are read-only, so startup must not resurrect their tmux shell.
  it.fails('does not restore a writable tmux process for an already-submitted planning session', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('planning-submitted-tmux', makePlanningSession({
      id: 'planning-submitted-tmux',
      status: 'submitted',
      submittedWorkflowId: 'wf-submitted',
      submittedPlanName: 'Submitted Plan',
      terminalMode: 'tmux',
      terminalSessionId: 'submitted-terminal-id',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'submitted output',
    }));
    const { restorePersistedPlanningTerminals, restoreSpawnSession } = bindRestoreHarness(sessions);

    restorePersistedPlanningTerminals();

    expect(restoreSpawnSession).not.toHaveBeenCalled();
  });
});
