import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRepository, SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  listPlanningChatSessions,
  restorePlanningChatSessions,
} from '../in-app-planner.js';

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

function makeRecord(overrides: Partial<InAppPlanningSessionRecord> = {}): InAppPlanningSessionRecord {
  return {
    id: 'planning-restore-repro',
    title: 'Planning restore repro',
    presetKey: 'codex',
    status: 'still_discussing',
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

describe('planning terminal restore invariants repros', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.fails('restores a persisted planning chat by remapping a missing preset to the configured default', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([
        makeRecord({
          id: 'legacy-missing-preset',
          title: 'Legacy missing preset',
          presetKey: 'legacy+planner',
        }),
      ], {
        config: { defaultSlackHarnessPreset: 'codex' },
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      expect(sessions.get('legacy-missing-preset')).toMatchObject({
        id: 'legacy-missing-preset',
        title: 'Legacy missing preset',
        presetKey: 'codex',
      });
    } finally {
      adapter.close();
    }
  });

  it.fails('does not resurrect a stale tmux handle for a submitted chat-mode planning session', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([
        makeRecord({
          id: 'submitted-chat-mode-with-stale-tmux',
          title: 'Submitted chat-mode session',
          status: 'submitted',
          submittedWorkflowId: 'wf-submitted',
          submittedPlanName: 'Submitted plan',
          terminalMode: 'chat',
          terminalSessionId: 'stale-planning-tmux-session',
          terminalStatus: 'running',
          terminalOutputSnapshot: 'old tmux output that should not reattach\n',
          terminalUpdatedAt: '2026-07-07T00:00:03.000Z',
        }),
      ], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      const restored = listPlanningChatSessions({ sessions }).sessions[0];
      expect(restored).toMatchObject({
        id: 'submitted-chat-mode-with-stale-tmux',
        status: 'submitted',
        terminalMode: 'chat',
      });
      expect(restored.terminalSessionId).toBeUndefined();
      expect(restored.terminalStatus).toBeUndefined();
      expect(restored.terminalOutputSnapshot).toBe('');
    } finally {
      adapter.close();
    }
  });
});

