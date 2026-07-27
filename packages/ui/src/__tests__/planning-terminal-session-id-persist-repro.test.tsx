import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningChatResponse } from '@invoker/contracts';
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
    dispose(): void {}
    write(): void {}
    refresh(): void {}
    focus(): void {}
    onData(): { dispose: () => void } {
      return { dispose() {} };
    }
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

const { App } = await import('../App.js');

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

describe('planning terminal failed first-send session id repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  // Desired behavior: if the app bridge creates a real session before the first
  // planner turn fails, the renderer must retain that id for the next send.
  it.fails('reuses the real sessionId returned by a failed first send on retry', async () => {
    const firstFailure: InAppPlanningChatResponse = {
      ok: false,
      sessionId: 'created-before-failure',
      error: 'Planner failed after creating the session.',
    };
    const secondSuccess: InAppPlanningChatResponse = {
      ok: true,
      sessionId: 'created-before-failure',
      reply: 'Retry stayed on the original planning chat.',
      draftPlanAvailable: false,
    };
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce(firstFailure)
      .mockResolvedValueOnce(secondSuccess) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the plan');
    await screen.findByText('Planner failed after creating the session.');

    submitPlanningText('retry the same plan');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
    });

    expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
      sessionId: 'created-before-failure',
      message: 'retry the same plan',
      presetKey: 'codex',
    });
  });
});
