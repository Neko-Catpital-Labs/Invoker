import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningChatResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

const xtermMock = vi.hoisted(() => ({
  Terminal: vi.fn().mockImplementation(() => ({
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
    open: vi.fn((host: HTMLElement) => {
      const element = document.createElement('div');
      element.className = 'xterm';
      host.appendChild(element);
    }),
    write: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    focus: vi.fn(),
  })),
  FitAddon: vi.fn().mockImplementation(() => ({ fit: vi.fn() })),
}));

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});
vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

const { App } = await import('../App.js');

describe('planning terminal failed first-send sessionId persistence repro', () => {
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

  // `it.fails`: current renderer state keeps the local placeholder id after
  // the first send fails, even when the app bridge returns the real sessionId.
  // The fix slice should remove `.fails` once retry sends include that id.
  it.fails('retries the same server planning session after a failed first send returns sessionId', async () => {
    const failedFirstSend: InAppPlanningChatResponse = {
      ok: false,
      sessionId: 'server-session-after-failure',
      error: 'planner exited before answering',
    };
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce(failedFirstSend)
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'server-session-after-failure',
        reply: 'Recovered on the same planning session.',
        draftPlanAvailable: false,
      } satisfies InAppPlanningChatResponse) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft a plan that fails on the first send');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'draft a plan that fails on the first send',
        presetKey: 'codex',
      });
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(
        'planner exited before answering',
      );
    });

    submitPlanningText('retry in the same failed conversation');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
    });
    expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
      sessionId: 'server-session-after-failure',
      message: 'retry in the same failed conversation',
      presetKey: 'codex',
    });
  });
});
