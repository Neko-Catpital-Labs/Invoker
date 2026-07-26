import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    focus(): void {}
    dispose(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => {} };
    }
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

const { App } = await import('../App.js');

describe('planning terminal failed-first-send session id repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
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

  // `it.fails`: desired invariant for the behavior slice. A failed first send
  // can still return the durable app-side session id; the renderer currently
  // leaves the active chat under its local placeholder id.
  it.fails('persists a real sessionId returned by a failed first send before retrying', async () => {
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        sessionId: 'real-session-after-first-failure',
        error: 'planner failed after creating the session',
      })
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'real-session-after-first-failure',
        reply: 'Recovered on the original planning session.',
        draftPlanAvailable: false,
      }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first request creates then fails');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(
        'planner failed after creating the session',
      );
    });

    submitPlanningText('retry on the same planning session');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2));

    expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
      sessionId: 'real-session-after-first-failure',
      message: 'retry on the same planning session',
      presetKey: 'codex',
    });
  });
});
