import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('planning terminal startup hydrate race repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    vi.restoreAllMocks();
  });

  async function openPlanningTerminal() {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  it.fails('preserves a local startup draft when delayed planning restore resolves', async () => {
    const restore = deferred<Awaited<ReturnType<NonNullable<typeof window.invoker.planningChatList>>>>();
    mock.api.planningChatList = vi.fn(() => restore.promise);

    render(<App />);
    await openPlanningTerminal();
    await waitFor(() => {
      expect(mock.api.planningChatList).toHaveBeenCalledTimes(2);
    });

    const input = screen.getByTestId('invoker-terminal-input');
    fireEvent.change(input, { target: { value: 'local draft typed before restore' } });
    expect(input).toHaveValue('local draft typed before restore');

    await act(async () => {
      restore.resolve({
        ok: true,
        sessions: [
          makePlanningSessionSummary({
            id: 'restored-startup-session',
            title: 'Restored startup chat',
            status: 'still_discussing',
            draftPlanAvailable: false,
            messages: [
              {
                id: 1,
                role: 'assistant',
                text: 'Restored assistant text from disk.',
                createdAt: '2026-07-07T00:00:02.000Z',
              },
            ],
          }),
        ],
      });
      await restore.promise;
    });

    await waitFor(() => {
      expect(within(screen.getByTestId('planning-session-list')).getByText('Restored startup chat')).toBeInTheDocument();
    });
    expect(screen.getByTestId('invoker-terminal-input')).toHaveValue('local draft typed before restore');
    expect(screen.getByTestId('invoker-terminal-transcript')).not.toHaveTextContent('Restored assistant text from disk.');
  });
});

