import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const xtermMock = vi.hoisted(() => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    focus = vi.fn();
    dispose = vi.fn();
  }

  class MockFitAddon {
    fit = vi.fn();
  }

  return { Terminal: MockTerminal, FitAddon: MockFitAddon };
});

vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

const { App } = await import('../App.js');

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function openPlanningTerminal() {
  fireEvent.click(await screen.findByTestId('sidebar-home'));
  const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
  if (expandPlanningChats) fireEvent.click(expandPlanningChats);
  fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
  await waitFor(() => {
    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
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

  it('repro: late startup hydrate overwrites edited local planning input', async () => {
    const hydrate = deferred<Awaited<ReturnType<MockInvoker['api']['planningChatList']>>>();
    mock.api.planningChatList = vi.fn(() => hydrate.promise) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), {
      target: { value: 'draft the restore race before startup finishes' },
    });
    expect(screen.getByTestId('invoker-terminal-input')).toHaveValue(
      'draft the restore race before startup finishes',
    );

    await act(async () => {
      hydrate.resolve({
        ok: true,
        sessions: [
          makePlanningSessionSummary({
            id: 'restored-after-edit',
            title: 'Restored after local edit',
            messages: [
              {
                id: 1,
                role: 'assistant',
                text: 'Persisted chat won the race.',
                createdAt: '2026-07-07T00:00:01.000Z',
              },
            ],
            draftPlanAvailable: false,
          }),
        ],
      });
      await hydrate.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-input')).toHaveValue('');
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Persisted chat won the race.');
    });
    expect(screen.queryByDisplayValue('draft the restore race before startup finishes')).not.toBeInTheDocument();
  });
});
