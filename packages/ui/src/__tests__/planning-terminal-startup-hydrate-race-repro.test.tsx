import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    focus(): void {}
    dispose(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => {} };
    }
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

const { App } = await import('../App.js');

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushReactWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('planning terminal startup hydrate race repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openPlanningTerminal(): Promise<void> {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
    if (expandPlanningChats) fireEvent.click(expandPlanningChats);
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string): void {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  // `it.fails`: desired invariant for the behavior slice. Current startup has
  // two hydrate paths; the terminal-aware hydrate can still overwrite a local
  // first-send session after that send has already completed.
  it.fails('does not let a late startup hydrate replace the first locally submitted chat', async () => {
    const firstHydrate = deferred<InAppPlanningListSessionsResponse>();
    const terminalAwareHydrate = deferred<InAppPlanningListSessionsResponse>();
    const staleStartupSnapshot: InAppPlanningListSessionsResponse = {
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'saved-before-local-send',
          title: 'Saved before local send',
          status: 'still_discussing',
          messages: [
            {
              id: 1,
              role: 'assistant',
              text: 'stale restored startup reply',
              createdAt: '2026-07-07T00:00:00.000Z',
            },
          ],
          draftPlanAvailable: false,
        }),
      ],
    };

    mock.api.planningChatList = vi
      .fn()
      .mockImplementationOnce(() => firstHydrate.promise)
      .mockImplementationOnce(() => terminalAwareHydrate.promise) as any;
    mock.api.planningTerminalList = vi.fn(async () => []) as any;
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'real-first-session',
      reply: 'live first-send reply',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    await waitFor(() => expect(mock.api.planningChatList).toHaveBeenCalledTimes(2));

    submitPlanningText('start planning before hydrate resolves');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('live first-send reply');
    });

    await act(async () => {
      firstHydrate.resolve(staleStartupSnapshot);
      terminalAwareHydrate.resolve(staleStartupSnapshot);
      await Promise.resolve();
    });
    await flushReactWork();

    const transcript = screen.getByTestId('invoker-terminal-transcript');
    expect(transcript).toHaveTextContent('live first-send reply');
    expect(transcript).not.toHaveTextContent('stale restored startup reply');
  });
});
