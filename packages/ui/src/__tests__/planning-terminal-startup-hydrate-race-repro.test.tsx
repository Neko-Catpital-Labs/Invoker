import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: vi.fn(() => null),
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
    vi.restoreAllMocks();
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

  // `it.fails`: desired behavior for the fix slice. Current startup restore can
  // still overwrite the first locally claimed planning chat when the delayed
  // hydrate response arrives after the local->real session handoff.
  it.fails('does not overwrite the first local planning send when startup hydrate resolves late', async () => {
    let resolveHydrate: ((value: InAppPlanningListSessionsResponse) => void) | null = null;
    mock.api.planningChatList = vi.fn(() => new Promise<InAppPlanningListSessionsResponse>((resolve) => {
      resolveHydrate = resolve;
    })) as any;
    mock.api.planningChatSend = vi.fn(async (request: any) => ({
      ok: true,
      sessionId: request.sessionId ?? 'real-first-session',
      reply: request.sessionId ? 'Follow-up kept the claimed session.' : 'First reply claimed a real session.',
      confirmationMode: 'require',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first message during startup');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('First reply claimed a real session.');
    });

    await act(async () => {
      resolveHydrate?.({
        ok: true,
        sessions: [makePlanningSessionSummary({
          id: 'stale-restored-session',
          title: 'Stale restored session',
          status: 'still_discussing',
          draftPlanAvailable: false,
          messages: [
            {
              id: 1,
              role: 'assistant',
              text: 'Stale restored transcript should not replace the live local send.',
              createdAt: '2026-07-07T00:00:01.000Z',
            },
          ],
        })],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('First reply claimed a real session.');
      expect(screen.getByTestId('invoker-terminal-transcript')).not.toHaveTextContent('Stale restored transcript');
    });

    submitPlanningText('continue claimed session');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'real-first-session',
        message: 'continue claimed session',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });
  });
});
