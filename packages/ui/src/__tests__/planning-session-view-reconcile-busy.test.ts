import { describe, it, expect } from 'vitest';
import { reconcileHydratedPlanningSessions, type PlanningSessionView } from '../lib/planning-session-view.js';

function makeSession(overrides: Partial<PlanningSessionView> = {}): PlanningSessionView {
  return {
    id: 'session-1',
    title: 'Untitled plan',
    status: 'still_discussing',
    presetKey: '',
    confirmationMode: 'require',
    messages: [],
    input: '',
    draftPlanAvailable: false,
    busy: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    conversationKey: 'session-1',
    mode: 'chat',
    terminalSession: null,
    terminalBusy: false,
    terminalError: null,
    ...overrides,
  } as PlanningSessionView;
}

describe('reconcileHydratedPlanningSessions busy derivation', () => {
  it('marks a session busy when the restored turn is running, even if the local view was not busy', () => {
    const current = [makeSession({ busy: false })];
    const restored = [makeSession({ busy: false, activeTurnStatus: 'running', activeTurnId: 'turn-1' })];

    const [merged] = reconcileHydratedPlanningSessions(current, restored);

    expect(merged.busy).toBe(true);
  });

  it('clears busy when the restored turn is no longer running', () => {
    const current = [makeSession({ busy: true })];
    const restored = [makeSession({ busy: false, activeTurnStatus: undefined, activeTurnId: undefined })];

    const [merged] = reconcileHydratedPlanningSessions(current, restored);

    expect(merged.busy).toBe(false);
  });
});
