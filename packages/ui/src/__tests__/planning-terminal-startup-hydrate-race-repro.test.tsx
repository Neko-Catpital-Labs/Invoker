import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('xterm', () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    write() {}
    onData() {
      return { dispose() {} };
    }
    dispose() {}
    focus() {}
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

const { App } = await import('../App.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

  async function openPlanningTerminal() {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
    if (expandPlanningChats) fireEvent.click(expandPlanningChats);
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  it('reproduces late startup hydrate replacing a completed first local send', async () => {
    const hydrate = deferred<InAppPlanningListSessionsResponse>();
    mock.api.planningChatList = vi.fn(() => hydrate.promise) as any;
    mock.api.planningTerminalList = vi.fn(async () => []) as any;
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'live-first-send',
      reply: 'live first response survives until hydrate',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first local request before hydrate resolves');

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('live first response survives until hydrate');
    });

    await act(async () => {
      hydrate.resolve({
        ok: true,
        sessions: [
          makePlanningSessionSummary({
            id: 'restored-stale-chat',
            title: 'Restored stale chat',
            status: 'still_discussing',
            draftPlanAvailable: false,
            messages: [
              {
                id: 1,
                role: 'assistant',
                text: 'stale restored response from startup hydrate',
                createdAt: '2026-07-07T00:00:03.000Z',
              },
            ],
            updatedAt: '2026-07-07T00:00:03.000Z',
          }),
        ],
      });
      await hydrate.promise;
    });

    await waitFor(() => {
      const transcript = screen.getByTestId('invoker-terminal-transcript');
      expect(transcript).toHaveTextContent('stale restored response from startup hydrate');
      expect(transcript).not.toHaveTextContent('live first response survives until hydrate');
    });
    expect(screen.getByTestId('planning-session-list')).toHaveTextContent('Restored stale chat');
    expect(mock.api.planningChatList).toHaveBeenCalledTimes(2);
  });
});
