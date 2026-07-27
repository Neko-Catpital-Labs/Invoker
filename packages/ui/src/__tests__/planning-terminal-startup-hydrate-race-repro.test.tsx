import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse } from '@invoker/contracts';
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
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  // `it.fails`: this asserts the desired lifecycle contract. Current startup
  // hydrate can overwrite a local chat that was sent while restore was pending.
  it.fails('keeps a user-started chat when delayed startup hydrate resolves afterward', async () => {
    const listResolvers: Array<(response: InAppPlanningListSessionsResponse) => void> = [];
    mock.api.planningChatList = vi.fn(() => new Promise<InAppPlanningListSessionsResponse>((resolve) => {
      listResolvers.push(resolve);
    })) as any;
    mock.api.planningTerminalList = vi.fn(async () => []) as any;
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'live-session-after-startup',
      reply: 'Local reply before hydrate.',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    await waitFor(() => expect(listResolvers).toHaveLength(2));

    submitPlanningText('keep the startup chat');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Local reply before hydrate.');
    });

    const restoredResponse: InAppPlanningListSessionsResponse = {
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'stale-restored-session',
          title: 'Stale restored session',
          status: 'still_discussing',
          draftPlanAvailable: false,
          messages: [
            {
              id: 1,
              role: 'assistant',
              text: 'Stale restored reply.',
              createdAt: '2026-07-07T00:00:01.000Z',
            },
          ],
        }),
      ],
    };

    await act(async () => {
      for (const resolve of listResolvers) resolve(restoredResponse);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Local reply before hydrate.');
    expect(screen.queryByText('Stale restored reply.')).not.toBeInTheDocument();
  });
});
