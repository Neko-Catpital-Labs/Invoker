import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  // `it.fails`: this asserts the desired invariant for the behavior slice. The
  // current renderer drops the real session id returned with a failed first send,
  // so retrying forks into a fresh planning conversation.
  it.fails('persists the real session id returned by a failed first send before retrying', async () => {
    const plannerError = 'cursor auth expired after the backend created a planner session';
    let sendCount = 0;
    mock.api.planningChatSend = vi.fn(async (request: any) => {
      sendCount += 1;
      if (sendCount === 1) {
        return { ok: false, sessionId: 'real-session-after-fail', error: plannerError };
      }
      return {
        ok: true,
        sessionId: request.sessionId ?? 'fresh-session-after-lost-id',
        reply: 'Recovered in a different session.',
        draftPlanAvailable: false,
      };
    }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft with expired auth');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(plannerError);
    });

    submitPlanningText('retry after login');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
    });

    const secondRequest = vi.mocked(mock.api.planningChatSend).mock.calls[1]?.[0] as { sessionId?: string };
    expect(secondRequest).toEqual({
      sessionId: 'real-session-after-fail',
      message: 'retry after login',
      presetKey: 'codex',
    });
  });
});
