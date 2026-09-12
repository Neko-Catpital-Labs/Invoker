import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning session active-id survives a real browser refresh', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    cleanup();
    mock.cleanup();
    vi.restoreAllMocks();
  });

  it('re-selects the session the user was on after a full unmount+remount, not the first one', async () => {
    const sessionA = makePlanningSessionSummary({ id: 'session-a', title: 'Session A' });
    const sessionB = makePlanningSessionSummary({ id: 'session-b', title: 'Session B' });
    mock.api.planningChatList = vi.fn(async () => ({ ok: true, sessions: [sessionA, sessionB] }));

    render(<App />);
    await screen.findByTitle('Session A');
    await screen.findByTitle('Session B');

    // Sanity: session A (sessions[0]) is active by default on first load.
    expect(screen.getByTitle('Session A').closest('[data-testid="planning-session-row"]')?.className)
      .toContain('bg-accent/40');

    // The user explicitly switches to session B.
    fireEvent.click(screen.getByTitle('Session B'));
    expect(screen.getByTitle('Session B').closest('[data-testid="planning-session-row"]')?.className)
      .toContain('bg-accent/40');
    expect(screen.getByTitle('Session A').closest('[data-testid="planning-session-row"]')?.className)
      .not.toContain('bg-accent/40');

    // Simulate a real browser refresh: full unmount wipes all in-memory React
    // state (nothing about "which session was active" is ever written to
    // localStorage or the server), then a fresh mount re-hydrates from the
    // same server-side session list.
    cleanup();
    render(<App />);
    await screen.findByTitle('Session A');
    await screen.findByTitle('Session B');

    // BUG: session B was never persisted as the active session, so the
    // fresh mount falls back to sessions[0] (session A) instead of
    // restoring what the user was actually looking at.
    expect(screen.getByTitle('Session B').closest('[data-testid="planning-session-row"]')?.className)
      .not.toContain('bg-accent/40');
    expect(screen.getByTitle('Session A').closest('[data-testid="planning-session-row"]')?.className)
      .toContain('bg-accent/40');
  });
});
