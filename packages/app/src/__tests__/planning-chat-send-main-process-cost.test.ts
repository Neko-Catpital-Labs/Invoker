import { describe, expect, it, vi } from 'vitest';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import type { InAppPlanningChatLine } from '@invoker/contracts';
import {
  createInAppPlanningChatSessions,
  sendPlanningChatMessage,
  type InAppPlanningChatSession,
  type InAppPlanningSessionStore,
} from '../in-app-planner.js';

const TRANSCRIPT_SIZE = 1_000;
const ROW_WRITE_BASELINE = 2_004;
const SESSION_ID = 'planning-send-baseline';

function buildTranscript(messageCount: number): InAppPlanningChatLine[] {
  return Array.from({ length: messageCount }, (_, index) => {
    const role: InAppPlanningChatLine['role'] = index % 2 === 0 ? 'user' : 'assistant';
    return {
      id: index + 1,
      role,
      text: `${role} baseline transcript message ${String(index + 1).padStart(4, '0')}`,
      createdAt: '2026-07-28T00:00:00.000Z',
    };
  });
}

function planningSession(overrides: Partial<InAppPlanningChatSession> & Pick<InAppPlanningChatSession, 'id' | 'title'>): InAppPlanningChatSession {
  return {
    presetKey: 'codex',
    confirmationMode: 'require',
    status: 'still_discussing',
    messages: [],
    conversation: new PlanConversation({}),
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    nextMessageId: 1,
    ...overrides,
  };
}

describe('planning chat send main-process cost', () => {
  it('captures the current 1,000-message row-write baseline for one send', async () => {
    const sessions = createInAppPlanningChatSessions();
    const messages = buildTranscript(TRANSCRIPT_SIZE);
    sessions.set(SESSION_ID, planningSession({
      id: SESSION_ID,
      title: 'Planning send baseline',
      messages,
      nextMessageId: TRANSCRIPT_SIZE + 1,
    }));

    const persistedMessageRows = new Map([[SESSION_ID, TRANSCRIPT_SIZE]]);
    const observedWrites: Array<{
      deletedMessageRows: number;
      insertedMessageRows: number;
      sessionRowWrites: number;
      rowWrites: number;
    }> = [];
    const planningSessionStore: InAppPlanningSessionStore = {
      upsertInAppPlanningSession(record) {
        const deletedMessageRows = persistedMessageRows.get(record.id) ?? 0;
        const insertedMessageRows = record.messages.length;
        const sessionRowWrites = 1;
        observedWrites.push({
          deletedMessageRows,
          insertedMessageRows,
          sessionRowWrites,
          rowWrites: deletedMessageRows + insertedMessageRows + sessionRowWrites,
        });
        persistedMessageRows.set(record.id, insertedMessageRows);
      },
      updateInAppPlanningSession: vi.fn(),
      deleteInAppPlanningSession: vi.fn(),
    };

    const result = await sendPlanningChatMessage({
      sessionId: SESSION_ID,
      message: 'capture the planning-send benchmark baseline',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder: vi.fn(() => ({ command: 'planner', args: ['prompt'] })),
      planningSessionStore,
      plannerReplyOverride: async () => 'Captured the planning-send baseline without drafting a plan.',
    });

    expect(result.ok).toBe(true);
    expect(sessions.get(SESSION_ID)?.messages).toHaveLength(TRANSCRIPT_SIZE + 2);
    expect(observedWrites).toEqual([
      {
        deletedMessageRows: TRANSCRIPT_SIZE,
        insertedMessageRows: TRANSCRIPT_SIZE + 1,
        sessionRowWrites: 1,
        rowWrites: 2_002,
      },
      {
        deletedMessageRows: TRANSCRIPT_SIZE + 1,
        insertedMessageRows: TRANSCRIPT_SIZE + 2,
        sessionRowWrites: 1,
        rowWrites: ROW_WRITE_BASELINE,
      },
    ]);
    expect(Math.max(...observedWrites.map((entry) => entry.rowWrites))).toBe(ROW_WRITE_BASELINE);
  });
});
