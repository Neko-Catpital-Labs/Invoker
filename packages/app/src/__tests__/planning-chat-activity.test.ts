import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInAppPlanningChatSessions,
  listPlanningChatSessions,
  restorePlanningChatSessions,
  sendPlanningChatMessage,
  type LoadedGeneratedPlan,
} from '../in-app-planner.js';
import { SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';
import type { InAppPlanningStreamEvent } from '@invoker/contracts';

const planningCommandBuilder = vi.fn(() => ({ command: 'codex', args: ['--print', 'prompt'] }));
const loadGeneratedPlan = vi.fn(async (): Promise<LoadedGeneratedPlan> => ({
  planName: 'unused',
  workflowId: 'wf-unused',
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function baseDeps(adapter: SQLiteAdapter, streams: InAppPlanningStreamEvent[] = []) {
  return {
    config: {},
    sessions: createInAppPlanningChatSessions(),
    planningCommandBuilder,
    loadGeneratedPlan,
    planningSessionStore: adapter,
    onRawPlannerOutput: (event: InAppPlanningStreamEvent) => streams.push(event),
  };
}

describe('planning chat turn activity runtime', () => {
  it('persists and restores exact stdout, stderr, and reasoning with turn ownership and final assistant association', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    const streams: InAppPlanningStreamEvent[] = [];
    try {
      const deps = baseDeps(adapter, streams);
      const result = await sendPlanningChatMessage({
        message: 'scope the work',
        turnId: 'turn-success-0001',
      }, {
        ...deps,
        plannerReplyOverride: async () => 'Use the existing data-store adapter path.',
        testPlanningActivityEvents: [
          { source: 'stdout', text: 'stdout raw\n' },
          { source: 'stderr', text: 'stderr raw\n' },
          { source: 'reasoning', text: 'provider summary' },
        ],
      });

      expect(result).toMatchObject({ ok: true, turnId: 'turn-success-0001' });
      const sessionId = result.ok ? result.sessionId : '';
      const activity = adapter.loadInAppPlanningTurnActivity(sessionId, 'turn-success-0001');
      expect(activity).toMatchObject({
        sessionId,
        turnId: 'turn-success-0001',
        userMessageId: 1,
        assistantMessageId: 2,
        status: 'completed',
        truncated: false,
      });
      expect(activity?.events.map((event) => ({
        sequence: event.sequence,
        source: event.source,
        text: event.text,
      }))).toEqual([
        { sequence: 1, source: 'stdout', text: 'stdout raw\n' },
        { sequence: 2, source: 'stderr', text: 'stderr raw\n' },
        { sequence: 3, source: 'reasoning', text: 'provider summary' },
      ]);
      expect(streams.map((event) => ({
        sessionId: event.sessionId,
        turnId: event.turnId,
        sequence: event.sequence,
        source: event.source,
        chunk: event.chunk,
      }))).toEqual([
        { sessionId, turnId: 'turn-success-0001', sequence: 1, source: 'stdout', chunk: 'stdout raw\n' },
        { sessionId, turnId: 'turn-success-0001', sequence: 2, source: 'stderr', chunk: 'stderr raw\n' },
        { sessionId, turnId: 'turn-success-0001', sequence: 3, source: 'reasoning', chunk: 'provider summary' },
      ]);

      const restored = createInAppPlanningChatSessions();
      await restorePlanningChatSessions(adapter.listInAppPlanningSessions(), {
        config: {},
        sessions: restored,
        planningCommandBuilder,
        loadGeneratedPlan,
        planningSessionStore: adapter,
      });
      const listed = listPlanningChatSessions({ sessions: restored });
      expect(listed.sessions[0]?.activity?.[0]?.events.map((event) => event.text)).toEqual([
        'stdout raw\n',
        'stderr raw\n',
        'provider summary',
      ]);
    } finally {
      adapter.close();
    }
  });

  it('keeps concurrent session activity isolated by explicit turn id instead of active-session state', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    const streams: InAppPlanningStreamEvent[] = [];
    try {
      const deps = baseDeps(adapter, streams);
      const first = sendPlanningChatMessage({
        message: 'first session',
        turnId: 'turn-concurrent-a',
      }, {
        ...deps,
        plannerReplyOverride: async () => 'first reply',
        testPlanningActivityEvents: [{ source: 'stdout', text: 'first stdout' }],
      });
      const second = sendPlanningChatMessage({
        message: 'second session',
        turnId: 'turn-concurrent-b',
      }, {
        ...deps,
        plannerReplyOverride: async () => 'second reply',
        testPlanningActivityEvents: [{ source: 'stdout', text: 'second stdout' }],
      });

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.ok && secondResult.ok).toBe(true);
      const firstSessionId = firstResult.ok ? firstResult.sessionId : '';
      const secondSessionId = secondResult.ok ? secondResult.sessionId : '';

      expect(adapter.loadInAppPlanningTurnActivity(firstSessionId, 'turn-concurrent-a')?.events[0]?.text).toBe('first stdout');
      expect(adapter.loadInAppPlanningTurnActivity(secondSessionId, 'turn-concurrent-b')?.events[0]?.text).toBe('second stdout');
      expect(adapter.loadInAppPlanningTurnActivity(firstSessionId, 'turn-concurrent-b')).toBeUndefined();
      expect(adapter.loadInAppPlanningTurnActivity(secondSessionId, 'turn-concurrent-a')).toBeUndefined();
      expect(streams.map((event) => [event.sessionId, event.turnId, event.sequence, event.chunk])).toEqual([
        [firstSessionId, 'turn-concurrent-a', 1, 'first stdout'],
        [secondSessionId, 'turn-concurrent-b', 1, 'second stdout'],
      ]);
    } finally {
      adapter.close();
    }
  });

  it('finalizes failed turns without inventing an assistant message id', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const result = await sendPlanningChatMessage({
        message: 'fail this turn',
        turnId: 'turn-failed-0001',
      }, {
        ...baseDeps(adapter),
        plannerReplyOverride: async () => {
          throw new Error('provider failed');
        },
        testPlanningActivityEvents: [
          { source: 'stdout', text: 'retry attempt stdout' },
          { source: 'stderr', text: 'retry attempt stderr' },
        ],
      });

      expect(result).toMatchObject({ ok: false, turnId: 'turn-failed-0001', error: 'provider failed' });
      const activity = adapter.loadInAppPlanningTurnActivity(result.sessionId ?? '', 'turn-failed-0001');
      expect(activity?.status).toBe('failed');
      expect(activity?.assistantMessageId).toBeUndefined();
      expect(activity?.events.map((event) => event.text)).toEqual(['retry attempt stdout', 'retry attempt stderr']);
    } finally {
      adapter.close();
    }
  });

  it('marks restored pending running activity as interrupted', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const record: InAppPlanningSessionRecord = {
        id: 'restore-interrupted',
        title: 'Restore interrupted',
        presetKey: 'codex',
        status: 'still_discussing',
        confirmationMode: 'require',
        messages: [{ id: 1, role: 'user', text: 'hello', createdAt: '2026-08-12T00:00:00.000Z' }],
        pendingResponse: true,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      };
      adapter.upsertInAppPlanningSession(record);
      adapter.startInAppPlanningTurnActivity({
        sessionId: 'restore-interrupted',
        turnId: 'turn-interrupted',
        userMessageId: 1,
        startedAt: '2026-08-12T00:00:01.000Z',
      });

      await restorePlanningChatSessions(adapter.listInAppPlanningSessions(), {
        config: {},
        sessions: createInAppPlanningChatSessions(),
        planningCommandBuilder,
        loadGeneratedPlan,
        planningSessionStore: adapter,
      });

      expect(adapter.loadInAppPlanningTurnActivity('restore-interrupted', 'turn-interrupted')?.status).toBe('interrupted');
    } finally {
      adapter.close();
    }
  });
});
