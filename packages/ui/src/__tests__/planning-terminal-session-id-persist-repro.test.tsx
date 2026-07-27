import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    write() {}
    onData() {
      return { dispose() {} };
    }
    focus() {}
    dispose() {}
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning terminal first-send sessionId persistence repro', () => {
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

  // `it.fails`: the app bridge can return a real sessionId even when the first
  // planner send fails after creating the conversation. The renderer must bind
  // retries to that real id instead of creating a second planning chat.
  it.fails('persists the real sessionId returned by a failed first send before retrying', async () => {
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        sessionId: 'real-session-after-first-fail',
        error: 'planner spawned but failed before replying',
      })
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'real-session-after-first-fail',
        reply: 'Recovered on the same planning session.',
        draftPlanAvailable: false,
      }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first request that fails after session creation');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('planner spawned but failed before replying');
    });

    submitPlanningText('retry on the persisted session');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'real-session-after-first-fail',
        message: 'retry on the persisted session',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });
  });
});
