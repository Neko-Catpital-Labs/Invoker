import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningChatResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

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

describe('planning terminal failed first-send session id repro', () => {
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

  it('reproduces dropping the real sessionId returned by a failed first send', async () => {
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        sessionId: 'real-session-after-failure',
        error: 'planner crashed after creating a session',
      } satisfies InAppPlanningChatResponse)
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'second-created-session',
        reply: 'Recovered in a different session.',
        draftPlanAvailable: false,
      } satisfies InAppPlanningChatResponse) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first request creates then fails');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('planner crashed after creating a session');
    });

    submitPlanningText('retry should reuse the failed session');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
    });

    const retryRequest = vi.mocked(mock.api.planningChatSend).mock.calls[1]?.[0] as Record<string, unknown>;
    expect(retryRequest).toEqual({
      message: 'retry should reuse the failed session',
      presetKey: 'codex',
      confirmationMode: 'require',
    });
    expect(retryRequest).not.toHaveProperty('sessionId');
  });
});
