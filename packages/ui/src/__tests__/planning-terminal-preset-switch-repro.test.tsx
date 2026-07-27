import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

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
    expect(screen.getByTestId('invoker-terminal-harness')).toBeInTheDocument();
  });
}

describe('planning terminal preset ownership repros', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  // Desired behavior: selecting a different saved chat restores that chat's
  // pinned preset instead of leaving the prior chat's composer preset active.
  it.fails('restores each saved chat preset when switching between planning chats', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'codex-chat',
          title: 'Codex plan',
          status: 'still_discussing',
          presetKey: 'codex',
          messages: [
            { id: 1, role: 'assistant', text: 'Codex chat reply.', createdAt: '2026-07-07T00:00:01.000Z' },
          ],
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
        }),
        makePlanningSessionSummary({
          id: 'omp-chat',
          title: 'OMP plan',
          status: 'still_discussing',
          presetKey: 'omp',
          messages: [
            { id: 1, role: 'assistant', text: 'OMP chat reply.', createdAt: '2026-07-07T00:00:01.000Z' },
          ],
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
        }),
      ],
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    await screen.findByRole('button', { name: /OMP plan/ });

    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    fireEvent.click(screen.getByRole('button', { name: /OMP plan/ }));

    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp');
  });

  it('uses the latest selected preset when tmux creates a planning chat', async () => {
    mock.api.planningChatCreate = vi.fn(() => new Promise(() => {})) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp' } });
    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp');

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledTimes(1);
    });
    expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
      presetKey: 'omp',
      title: 'Untitled plan',
    });
  });
});
