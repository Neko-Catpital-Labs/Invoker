import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningChatResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning terminal first-send session id persistence repro', () => {
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
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  it.fails('continues the real backend session when the first send fails after creating one', async () => {
    const failedFirstSend: InAppPlanningChatResponse = {
      ok: false,
      sessionId: 'created-session-after-first-failure',
      error: 'planner exited before producing a reply',
    };
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce(failedFirstSend)
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'created-session-after-first-failure',
        reply: 'Retry kept the original session.',
        draftPlanAvailable: false,
      } satisfies InAppPlanningChatResponse) as never;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first message creates a backend session then fails');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('planner exited before producing a reply');
    });

    submitPlanningText('retry in the same session');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
    });

    expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
      sessionId: 'created-session-after-first-failure',
      message: 'retry in the same session',
      presetKey: 'codex',
    });
  });
});

