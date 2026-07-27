import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningChatResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const xtermMock = vi.hoisted(() => {
  class MockTerminal {
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    focus = vi.fn();
    dispose = vi.fn();
    cols = 80;
    rows = 24;
  }

  class MockFitAddon {
    fit = vi.fn();
  }

  return { Terminal: MockTerminal, FitAddon: MockFitAddon };
});

vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

const { App } = await import('../App.js');

async function openOptions(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
  await waitFor(() => {
    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
  });
}

function submitPlanningText(text: string): void {
  fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
  fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
}

describe('planning terminal first-send session id persist repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    cleanup();
    mock.cleanup();
    vi.restoreAllMocks();
  });

  it('reproduces a failed first send dropping the real sessionId returned by the bridge', async () => {
    const firstFailure: InAppPlanningChatResponse = {
      ok: false,
      sessionId: 'real-session-after-failure',
      error: 'planner failed after allocating a session',
    };
    const secondSuccess: InAppPlanningChatResponse = {
      ok: true,
      sessionId: 'second-session-created-by-retry',
      reply: 'second assistant reply',
      confirmationMode: 'require',
      draftPlanAvailable: false,
    };
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce(firstFailure)
      .mockResolvedValueOnce(secondSuccess) as any;

    render(<App />);
    await openOptions();

    submitPlanningText('first request');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('planner failed after allocating a session');
    });

    submitPlanningText('retry after first failure');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
    });
    const retryRequest = vi.mocked(mock.api.planningChatSend).mock.calls[1]?.[0] as Record<string, unknown>;
    expect(retryRequest).toMatchObject({
      message: 'retry after first failure',
      presetKey: 'codex',
      confirmationMode: 'require',
    });
    expect(retryRequest).not.toHaveProperty('sessionId');
  });
});
