import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

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

describe('planning terminal failed first send session id persist repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    vi.restoreAllMocks();
  });

  it.fails('continues the real planning session id returned by a failed first send', async () => {
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        sessionId: 'real-session-after-failed-first-send',
        error: 'planner exited before producing a reply',
      })
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'real-session-after-failed-first-send',
        reply: 'Recovered in the same conversation.',
        draftPlanAvailable: false,
      }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the initial plan');
    expect(await screen.findByText('planner exited before producing a reply')).toBeInTheDocument();

    submitPlanningText('retry in the same planner thread');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
    });
    expect(mock.api.planningChatSend).toHaveBeenNthCalledWith(2, {
      sessionId: 'real-session-after-failed-first-send',
      message: 'retry in the same planner thread',
      presetKey: 'codex',
      confirmationMode: 'require',
    });
  });
});
