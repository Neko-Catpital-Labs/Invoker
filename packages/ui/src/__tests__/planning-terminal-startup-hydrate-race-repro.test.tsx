import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

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
    if (!screen.queryByTestId('invoker-terminal-harness')) {
      fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    }
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  it('reproduces late startup hydrate replacing the locally active first chat', async () => {
    let resolveHydrate: ((value: Awaited<ReturnType<MockInvoker['api']['planningChatList']>>) => void) | null = null;
    const hydratePromise = new Promise<Awaited<ReturnType<MockInvoker['api']['planningChatList']>>>((resolve) => {
      resolveHydrate = resolve;
    });
    mock.api.planningChatList = vi.fn(() => hydratePromise) as any;
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'live-first-send',
      reply: 'Live first reply before hydrate.',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('live first prompt before restore');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Live first reply before hydrate.');
    });
    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('live first prompt before restore');

    resolveHydrate?.({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'persisted-before-race',
          title: 'Persisted before race',
          status: 'still_discussing',
          draftPlanAvailable: false,
          messages: [
            {
              id: 1,
              role: 'assistant',
              text: 'Persisted transcript won the late hydrate race.',
              createdAt: '2026-07-07T00:00:00.000Z',
            },
          ],
        }),
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Persisted transcript won the late hydrate race.');
    });
    expect(screen.getByTestId('invoker-terminal-transcript')).not.toHaveTextContent('live first prompt before restore');
    expect(mock.api.planningChatList).toHaveBeenCalledTimes(2);
  });
});
