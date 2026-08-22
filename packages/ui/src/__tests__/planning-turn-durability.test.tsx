import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Dynamic import is required so App sees the hoisted @xyflow/react mock.
const { App } = await import('../App.js');

describe('planning turn durability', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openPlanningSurface() {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-input')).toBeInTheDocument();
    });
  }

  it('keeps a hydrated running turn busy and lands its reply from the stream event', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'busy-chat',
          title: 'Busy chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          messages: [
            { id: 1, role: 'user', text: 'Draft the plan', createdAt: '2026-07-07T00:00:01.000Z' },
          ],
          activeTurnId: 'turn-live',
          activeTurnStatus: 'running',
        }),
      ],
    }));

    render(<App />);
    await openPlanningSurface();

    // Reload-safe busy: the hydrated running turn locks the composer.
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled();
    });

    await act(async () => {
      mock.firePlanningChatStream({
        sessionId: 'busy-chat',
        turnId: 'turn-live',
        turn: { status: 'completed', reply: 'Done thinking.', draftPlanAvailable: false },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Done thinking.');
      expect(screen.getByTestId('invoker-terminal-input')).not.toBeDisabled();
    });
  });

  it('offers Retry for a hydrated failed turn and re-sends the same turnId and message', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'failed-chat',
          title: 'Failed chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          messages: [
            { id: 1, role: 'user', text: 'Draft the plan', createdAt: '2026-07-07T00:00:01.000Z' },
          ],
          activeTurnId: 'turn-x',
          activeTurnStatus: 'failed',
          activeTurnError: 'Planner was interrupted before it could answer.',
        }),
      ],
    }));
    mock.api.planningChatSend = vi.fn(async (request: { sessionId?: string; turnId?: string }) => ({
      ok: true as const,
      sessionId: request.sessionId ?? 'failed-chat',
      turnId: request.turnId,
      reply: 'Recovered fine.',
      confirmationMode: 'require' as const,
      draftPlanAvailable: false,
    }));

    render(<App />);
    await openPlanningSurface();

    const retryButton = await screen.findByTestId('invoker-terminal-retry-turn');
    expect(screen.getByTestId('invoker-terminal-turn-error'))
      .toHaveTextContent('Planner was interrupted before it could answer.');

    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'failed-chat',
        turnId: 'turn-x',
        message: 'Draft the plan',
      }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Recovered fine.');
    });
    expect(screen.queryByTestId('invoker-terminal-retry-turn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoker-terminal-turn-error')).not.toBeInTheDocument();
  });

  it('silently ignores a duplicate-turn response and stays busy', async () => {
    mock.api.planningChatSend = vi.fn(async (request: { turnId?: string }) => ({
      ok: false as const,
      sessionId: 'session-1',
      turnId: request.turnId,
      error: 'duplicate-turn',
    }));

    render(<App />);
    await openPlanningSurface();

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'hello planner' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1);
    });
    // The original request's outcome will land via response, event, or poll:
    // the session stays busy and no error UI appears.
    expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled();
    expect(screen.queryByText('Planner could not respond')).not.toBeInTheDocument();
    expect(screen.queryByText(/duplicate-turn/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoker-terminal-retry-turn')).not.toBeInTheDocument();
  });

  it('keeps one chat row when the poll observes the in-flight send before the response lands', async () => {
    let resolveSend: (() => void) | undefined;
    mock.api.planningChatSend = vi.fn((request: { turnId?: string }) => new Promise((resolve) => {
      resolveSend = () => resolve({
        ok: true,
        sessionId: 'server-1',
        turnId: request.turnId,
        reply: 'Landed on the server session.',
        confirmationMode: 'require',
        draftPlanAvailable: false,
      });
    })) as typeof mock.api.planningChatSend;
    // Empty at mount; the backend session appears only once the send is in
    // flight, exactly what the busy poll would observe server-side.
    const serverSessions = { current: [] as ReturnType<typeof makePlanningSessionSummary>[] };
    mock.api.planningChatList = vi.fn(async () => ({ ok: true, sessions: serverSessions.current }));

    render(<App />);
    await openPlanningSurface();

    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'hello planner' } });
      fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
      serverSessions.current = [
        makePlanningSessionSummary({
          id: 'server-1',
          title: 'Server chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          messages: [
            { id: 1, role: 'user', text: 'hello planner', createdAt: '2026-07-07T00:00:01.000Z' },
          ],
          activeTurnId: 'turn-live',
          activeTurnStatus: 'running',
        }),
      ];

      // The busy poll observes the backend session for this in-flight send.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      // No duplicate row: the backend session is not appended as a new chat.
      expect(screen.queryByText('Server chat')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }

    await act(async () => {
      resolveSend?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Landed on the server session.');
    });
  });

  it('lands a turn outcome exactly once when both the response and the stream event deliver it', async () => {
    render(<App />);
    await openPlanningSurface();

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'hello planner' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('I can help draft that.');
    });

    const sendRequest = vi.mocked(mock.api.planningChatSend).mock.calls[0]?.[0] as { turnId?: string };
    expect(typeof sendRequest.turnId).toBe('string');

    await act(async () => {
      mock.firePlanningChatStream({
        sessionId: 'session-1',
        turnId: sendRequest.turnId,
        turn: { status: 'completed', reply: 'I can help draft that.', draftPlanAvailable: false },
      });
    });

    const transcriptText = screen.getByTestId('invoker-terminal-transcript').textContent ?? '';
    expect(transcriptText.split('I can help draft that.').length - 1).toBe(1);
    expect(screen.getByTestId('invoker-terminal-input')).not.toBeDisabled();
  });

  it('lands a failed turn outcome exactly once when both the response and the stream event deliver it', async () => {
    mock.api.planningChatSend = vi.fn(async (request: { sessionId?: string; turnId?: string }) => ({
      ok: false as const,
      sessionId: request.sessionId ?? 'session-1',
      turnId: request.turnId,
      error: 'Planner was interrupted before it could answer.',
    }));

    render(<App />);
    await openPlanningSurface();

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'hello planner' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-turn-error'))
        .toHaveTextContent('Planner was interrupted before it could answer.');
    });

    const sendRequest = vi.mocked(mock.api.planningChatSend).mock.calls[0]?.[0] as { sessionId?: string; turnId?: string };
    expect(typeof sendRequest.turnId).toBe('string');

    // A lagging stream event re-delivers the same failure for the same
    // turnId after the direct response already landed it.
    await act(async () => {
      mock.firePlanningChatStream({
        sessionId: sendRequest.sessionId ?? 'session-1',
        turnId: sendRequest.turnId,
        turn: { status: 'failed', error: 'Planner was interrupted before it could answer.' },
      });
    });

    const transcriptText = screen.getByTestId('invoker-terminal-transcript').textContent ?? '';
    expect(transcriptText.split('Planner was interrupted before it could answer.').length - 1).toBe(1);
    expect(screen.getByTestId('invoker-terminal-retry-turn')).toBeInTheDocument();
  });
  it('fails a wiped mid-first-send turn into the banner and keeps the chat', async () => {
    mock.api.planningChatSend = vi.fn((request: { turnId?: string }) => new Promise(() => {
      void request; // never resolves: the server was wiped mid-turn
    })) as typeof mock.api.planningChatSend;
    const serverSessions = { current: [] as ReturnType<typeof makePlanningSessionSummary>[] };
    mock.api.planningChatList = vi.fn(async () => ({ ok: true, sessions: serverSessions.current }));

    render(<App />);
    await openPlanningSurface();

    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'hello planner' } });
      fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
      serverSessions.current = [
        makePlanningSessionSummary({
          id: 'server-1',
          title: 'Server chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          messages: [
            { id: 1, role: 'user', text: 'hello planner', createdAt: '2026-07-07T00:00:01.000Z' },
          ],
          activeTurnId: 'turn-live',
          activeTurnStatus: 'running',
        }),
      ];

      // While the server still reports the running turn, nothing fails.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(screen.queryByTestId('invoker-terminal-turn-error')).not.toBeInTheDocument();

      // Server wiped: two consecutive polls prove the turn is gone.
      serverSessions.current = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(screen.queryByTestId('invoker-terminal-turn-error')).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });

      expect(screen.getByTestId('invoker-terminal-turn-error'))
        .toHaveTextContent('The planner session no longer exists on the server. It may have been reset.');
      expect(screen.getByTestId('invoker-terminal-retry-turn')).toBeInTheDocument();
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('hello planner');
      expect(screen.queryByTestId('invoker-terminal-send-spinner')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a hydrated running turn when its server session disappears, keeping the row and transcript', async () => {
    const serverSessions = {
      current: [
        makePlanningSessionSummary({
          id: 'busy-chat',
          title: 'Busy chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          messages: [
            { id: 1, role: 'user', text: 'Draft the plan', createdAt: '2026-07-07T00:00:01.000Z' },
          ],
          activeTurnId: 'turn-live',
          activeTurnStatus: 'running',
        }),
      ] as ReturnType<typeof makePlanningSessionSummary>[],
    };
    mock.api.planningChatList = vi.fn(async () => ({ ok: true, sessions: serverSessions.current }));

    // Fake timers from the start so the busy poll's interval is fake-timer
    // driven even though hydration (not a send) flips the session busy.
    vi.useFakeTimers();
    try {
      render(<App />);
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId('sidebar-home'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled();

      serverSessions.current = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(screen.queryByTestId('invoker-terminal-turn-error')).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });

      expect(screen.getByTestId('invoker-terminal-turn-error'))
        .toHaveTextContent('The planner session no longer exists on the server. It may have been reset.');
      expect(screen.getByTestId('invoker-terminal-retry-turn')).toBeInTheDocument();
      expect(screen.getAllByText('Busy chat').length).toBeGreaterThan(0);
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Draft the plan');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fail the turn on a transient one-poll miss', async () => {
    mock.api.planningChatSend = vi.fn((request: { turnId?: string }) => new Promise(() => {
      void request;
    })) as typeof mock.api.planningChatSend;
    const runningServerSession = makePlanningSessionSummary({
      id: 'server-1',
      title: 'Server chat',
      status: 'still_discussing',
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      draftPlanText: undefined,
      messages: [
        { id: 1, role: 'user', text: 'hello planner', createdAt: '2026-07-07T00:00:01.000Z' },
      ],
      activeTurnId: 'turn-live',
      activeTurnStatus: 'running',
    });
    const serverSessions = { current: [] as ReturnType<typeof makePlanningSessionSummary>[] };
    mock.api.planningChatList = vi.fn(async () => ({ ok: true, sessions: serverSessions.current }));

    render(<App />);
    await openPlanningSurface();

    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'hello planner' } });
      fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
      serverSessions.current = [runningServerSession];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });

      // One empty poll: not enough to fail the turn.
      serverSessions.current = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(screen.queryByTestId('invoker-terminal-turn-error')).not.toBeInTheDocument();

      // The turn reappears: the gone counter resets.
      serverSessions.current = [runningServerSession];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });

      expect(screen.queryByTestId('invoker-terminal-turn-error')).not.toBeInTheDocument();
      expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a late send response overwrite the gone-turn failure', async () => {
    let resolveSend: (() => void) | undefined;
    mock.api.planningChatSend = vi.fn((request: { turnId?: string }) => new Promise((resolve) => {
      resolveSend = () => resolve({
        ok: true,
        sessionId: 'server-1',
        turnId: request.turnId,
        reply: 'Landed after all.',
        confirmationMode: 'require',
        draftPlanAvailable: false,
      });
    })) as typeof mock.api.planningChatSend;
    const serverSessions = { current: [] as ReturnType<typeof makePlanningSessionSummary>[] };
    mock.api.planningChatList = vi.fn(async () => ({ ok: true, sessions: serverSessions.current }));

    render(<App />);
    await openPlanningSurface();

    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'hello planner' } });
      fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
      serverSessions.current = [
        makePlanningSessionSummary({
          id: 'server-1',
          title: 'Server chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          messages: [
            { id: 1, role: 'user', text: 'hello planner', createdAt: '2026-07-07T00:00:01.000Z' },
          ],
          activeTurnId: 'turn-live',
          activeTurnStatus: 'running',
        }),
      ];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      serverSessions.current = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(screen.getByTestId('invoker-terminal-turn-error')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }

    // The failed turn keeps its activeTurnId, so the genuine reply still lands.
    await act(async () => {
      resolveSend?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Landed after all.');
    });
    expect(screen.queryByTestId('invoker-terminal-turn-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoker-terminal-retry-turn')).not.toBeInTheDocument();
  });
});
