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
const ROW_WRITE_TARGET = 2;
const SESSION_ID = 'planning-send-baseline';

type PersistedMessageState = {
  count: number;
  maxMessageId: number;
};

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

function persistedStateForMessages(messages: InAppPlanningChatLine[]): PersistedMessageState {
  return {
    count: messages.length,
    maxMessageId: messages.reduce((maxMessageId, message) => Math.max(maxMessageId, message.id), 0),
  };
}

function canAppendPlanningMessages(
  messages: InAppPlanningChatLine[],
  persistedState: PersistedMessageState,
): boolean {
  if (persistedState.count > messages.length) return false;

  let previousMessageId = 0;
  for (const message of messages) {
    if (!Number.isSafeInteger(message.id) || message.id <= previousMessageId) {
      return false;
    }
    previousMessageId = message.id;
  }

  if (persistedState.count === 0) return true;
  return messages[persistedState.count - 1]?.id === persistedState.maxMessageId;
}

describe('planning chat send main-process cost', () => {
  it('persists only appended planning messages for one 1,000-message send', async () => {
    const sessions = createInAppPlanningChatSessions();
    const messages = buildTranscript(TRANSCRIPT_SIZE);
    sessions.set(SESSION_ID, planningSession({
      id: SESSION_ID,
      title: 'Planning send baseline',
      messages,
      nextMessageId: TRANSCRIPT_SIZE + 1,
    }));

    const persistedMessages = new Map([[SESSION_ID, messages]]);
    const persistedMessageStates = new Map([[SESSION_ID, persistedStateForMessages(messages)]]);
    const cachedMessageStates = new Map<string, PersistedMessageState>();
    const observedCost: {
      baselineRowWrites: number;
      deletedMessageRows: number;
      insertedMessageRows: number;
      sessionRowWrites: number;
      fullTranscriptReloads: number;
      countQueries: number;
    } = {
      baselineRowWrites: ROW_WRITE_BASELINE,
      deletedMessageRows: 0,
      insertedMessageRows: 0,
      sessionRowWrites: 0,
      fullTranscriptReloads: 0,
      countQueries: 0,
    };
    const planningSessionStore: InAppPlanningSessionStore = {
      upsertInAppPlanningSession(record) {
        observedCost.sessionRowWrites += 1;
        let persistedState = cachedMessageStates.get(record.id);
        if (!persistedState) {
          observedCost.countQueries += 1;
          persistedState = persistedMessageStates.get(record.id) ?? { count: 0, maxMessageId: 0 };
          cachedMessageStates.set(record.id, persistedState);
        }

        if (canAppendPlanningMessages(record.messages, persistedState)) {
          const unseenMessages = record.messages.slice(persistedState.count);
          observedCost.insertedMessageRows += unseenMessages.length;
        } else {
          const existingMessages = persistedMessages.get(record.id) ?? [];
          observedCost.fullTranscriptReloads += 1;
          observedCost.deletedMessageRows += existingMessages.length;
          observedCost.insertedMessageRows += record.messages.length;
        }

        const updatedMessages = record.messages.map((message) => ({ ...message }));
        const updatedState = persistedStateForMessages(updatedMessages);
        persistedMessages.set(record.id, updatedMessages);
        persistedMessageStates.set(record.id, updatedState);
        cachedMessageStates.set(record.id, updatedState);
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
    expect(observedCost).toEqual({
      baselineRowWrites: ROW_WRITE_BASELINE,
      deletedMessageRows: 0,
      insertedMessageRows: ROW_WRITE_TARGET,
      sessionRowWrites: 2,
      fullTranscriptReloads: 0,
      countQueries: 1,
    });
  });
});
