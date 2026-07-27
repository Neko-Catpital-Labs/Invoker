import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    dispose() {}
    focus() {}
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

const { App } = await import('../App.js');

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

  it.fails('does not let a late startup hydrate overwrite a locally submitted first planning turn', async () => {
    const pendingHydrates: Array<(value: unknown) => void> = [];
    mock.api.planningChatList = vi.fn(() => new Promise((resolve) => {
      pendingHydrates.push(resolve);
    }) as any) as any;
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'fresh-session-from-send',
      reply: 'Fresh reply from the first local turn.',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    await waitFor(() => expect(mock.api.planningChatList).toHaveBeenCalledTimes(2));

    submitPlanningText('first local turn before hydrate returns');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Fresh reply from the first local turn.');
    });

    await act(async () => {
      for (const resolve of pendingHydrates) {
        resolve({
          ok: true,
          sessions: [
            makePlanningSessionSummary({
              id: 'stale-restored-session',
              title: 'Stale restored session',
              status: 'still_discussing',
              draftPlanAvailable: false,
              draftPlanSummary: undefined,
              messages: [
                {
                  id: 1,
                  role: 'assistant',
                  text: 'Stale restored transcript from startup.',
                  createdAt: '2026-07-07T00:00:00.000Z',
                },
              ],
            }),
          ],
        });
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    const transcript = screen.getByTestId('invoker-terminal-transcript');
    expect(transcript).toHaveTextContent('Fresh reply from the first local turn.');
    expect(transcript).not.toHaveTextContent('Stale restored transcript from startup.');
  });
});
