import { describe, it, expect } from 'vitest';
import { maxPlanningMessageId, type PlanningSessionView } from '../lib/planning-session-view.js';

function makeSession(messageIds: number[]): PlanningSessionView {
  return {
    id: `session-${messageIds[0] ?? 'empty'}`,
    title: 'Untitled plan',
    status: 'still_discussing',
    presetKey: '',
    confirmationMode: 'require',
    messages: messageIds.map((id) => ({ id, text: `message ${id}`, role: 'assistant' })),
    input: '',
    draftPlanAvailable: false,
    busy: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    conversationKey: `session-${messageIds[0] ?? 'empty'}`,
    mode: 'chat',
    terminalSession: null,
    terminalBusy: false,
    terminalError: null,
  } as PlanningSessionView;
}

describe('maxPlanningMessageId', () => {
  it('returns 1 for no sessions or sessions with no messages', () => {
    expect(maxPlanningMessageId([])).toBe(1);
    expect(maxPlanningMessageId([makeSession([])])).toBe(1);
  });

  it('returns the highest message id across all restored sessions', () => {
    const sessions = [makeSession([1, 5, 3]), makeSession([2, 9])];
    expect(maxPlanningMessageId(sessions)).toBe(9);
  });

  it('does not throw on a message count that would overflow a spread-based Math.max', () => {
    const hugeMessageIds = Array.from({ length: 200_000 }, (_, index) => index + 1);
    const sessions = [makeSession(hugeMessageIds)];
    expect(() => Math.max(1, ...hugeMessageIds)).toThrow(RangeError);
    expect(() => maxPlanningMessageId(sessions)).not.toThrow();
    expect(maxPlanningMessageId(sessions)).toBe(200_000);
  });
});
