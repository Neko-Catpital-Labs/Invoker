import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse } from '@invoker/contracts';
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

  // `it.fails`: desired behavior is that stale startup hydrate responses cannot
  // replace a user-started chat. Current code still has a second hydrate path
  // that can overwrite the active local send after it adopts a real session id.
  it.fails('keeps the active first-send chat when stale startup hydration resolves later', async () => {
    const hydrateResolvers: Array<(value: InAppPlanningListSessionsResponse) => void> = [];
    mock.api.planningChatList = vi.fn(() => new Promise<InAppPlanningListSessionsResponse>((resolve) => {
      hydrateResolvers.push(resolve);
    })) as any;
    mock.api.planningTerminalList = vi.fn(async () => []) as any;
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'live-session-from-first-send',
      reply: 'Live reply from the first send.',
      confirmationMode: 'require',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    await waitFor(() => {
      expect(mock.api.planningChatList).toHaveBeenCalledTimes(2);
    });

    submitPlanningText('start while restore is pending');
    await screen.findByText('Live reply from the first send.');

    const staleHydrate: InAppPlanningListSessionsResponse = {
      ok: true,
      sessions: [makePlanningSessionSummary({
        id: 'stale-restored-session',
        title: 'Stale restored session',
        status: 'still_discussing',
        draftPlanAvailable: false,
        draftPlanSummary: undefined,
        draftPlanText: undefined,
        messages: [
          {
            id: 1,
            role: 'assistant',
            text: 'Stale restored reply.',
            createdAt: '2026-07-07T00:00:02.000Z',
          },
        ],
      })],
    };

    await act(async () => {
      for (const resolve of hydrateResolvers) resolve(staleHydrate);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Live reply from the first send.');
    expect(screen.getByTestId('invoker-terminal-transcript')).not.toHaveTextContent('Stale restored reply.');
    expect(screen.getByText('start while restore is pending')).toBeInTheDocument();
  });
});
