import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('planning terminal failed first-send session id repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('repro: a failed first send that returns a real sessionId is not reused by the next send', async () => {
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        sessionId: 'real-session-after-failure',
        error: 'planner exited before the first answer',
      })
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'second-created-session',
        reply: 'Recovered on a new session.',
        draftPlanAvailable: false,
      }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first send creates then fails');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(
        'planner exited before the first answer',
      );
    });

    submitPlanningText('retry should have used the failed session id');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Recovered on a new session.');
    });

    expect(mock.api.planningChatSend).toHaveBeenNthCalledWith(1, {
      message: 'first send creates then fails',
      presetKey: 'codex',
    });
    expect(mock.api.planningChatSend).toHaveBeenNthCalledWith(2, {
      message: 'retry should have used the failed session id',
      presetKey: 'codex',
    });
  });
});
