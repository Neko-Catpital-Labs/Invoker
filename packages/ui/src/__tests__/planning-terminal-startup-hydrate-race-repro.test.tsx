import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse, InAppPlanningChatResponse } from '@invoker/contracts';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
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

  it('reproduces delayed startup hydrate replacing an already-started local planning turn', async () => {
    const hydrateCalls: Array<ReturnType<typeof deferred<InAppPlanningListSessionsResponse>>> = [];
    mock.api.planningChatList = vi.fn(() => {
      const hydrate = deferred<InAppPlanningListSessionsResponse>();
      hydrateCalls.push(hydrate);
      return hydrate.promise;
    }) as any;
    mock.api.planningTerminalList = vi.fn(async () => []);
    mock.api.planningChatSend = vi.fn(() => new Promise<InAppPlanningChatResponse>(() => {})) as any;

    render(<App />);
    await openPlanningTerminal();
    await waitFor(() => {
      expect(hydrateCalls).toHaveLength(2);
    });

    submitPlanningText('race-start local request');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('race-start local request');
    });

    await act(async () => {
      for (const hydrate of hydrateCalls) {
        hydrate.resolve({
          ok: true,
          sessions: [
            makePlanningSessionSummary({
              id: 'restored-after-local-start',
              title: 'Restored after local start',
              status: 'still_discussing',
              messages: [
                {
                  id: 1,
                  role: 'assistant',
                  text: 'restored transcript from disk',
                  createdAt: '2026-07-07T00:00:01.000Z',
                },
              ],
              draftPlanAvailable: false,
            }),
          ],
        });
      }
      await Promise.resolve();
    });

    await waitFor(() => {
      const transcript = screen.getByTestId('invoker-terminal-transcript');
      expect(transcript).toHaveTextContent('restored transcript from disk');
      expect(transcript).not.toHaveTextContent('race-start local request');
    });
  });
});
