import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: vi.fn(() => null),
});

const { App } = await import('../App.js');

describe('planning terminal failed first send sessionId persist repro', () => {
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

  // `it.fails`: desired behavior for the fix slice. Current renderer keeps the
  // local id after a failed first send even when the app bridge returns a real
  // sessionId, so the retry starts a new backend chat instead of continuing.
  it.fails('retries a failed first send against the real sessionId returned by the app bridge', async () => {
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        sessionId: 'real-failed-first-session',
        error: 'planner exited before writing a reply',
      })
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'real-failed-first-session',
        reply: 'Retry recovered the original session.',
        confirmationMode: 'require',
        draftPlanAvailable: false,
      }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the plan');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('planner exited before writing a reply');
    });

    submitPlanningText('retry the same plan');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'real-failed-first-session',
        message: 'retry the same plan',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });
  });
});
