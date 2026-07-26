import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { InAppPlanningCreateSessionRequest } from '@invoker/contracts';
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

describe('planning terminal preset switching repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openPlanningTerminal(): Promise<void> {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
    if (expandPlanningChats) fireEvent.click(expandPlanningChats);
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  // `it.fails`: desired invariant for the behavior slice. The preset select is
  // currently global, so selecting another persisted chat can leave the UI on
  // the previous chat's preset.
  it.fails('updates the visible preset when switching between restored planning chats', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'chat-codex',
          title: 'Codex chat',
          presetKey: 'codex',
          messages: [
            { id: 1, role: 'assistant', text: 'Codex restored message', createdAt: '2026-07-07T00:00:00.000Z' },
          ],
          draftPlanAvailable: false,
        }),
        makePlanningSessionSummary({
          id: 'chat-claude',
          title: 'Claude chat',
          presetKey: 'omp+claude',
          messages: [
            { id: 1, role: 'assistant', text: 'Claude restored message', createdAt: '2026-07-07T00:00:00.000Z' },
          ],
          draftPlanAvailable: false,
        }),
      ],
    })) as any;
    mock.api.planningTerminalList = vi.fn(async () => []) as any;

    render(<App />);
    await openPlanningTerminal();

    const rail = await screen.findByTestId('planning-session-list');
    fireEvent.click(within(rail).getByRole('button', { name: /Claude chat/ }));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Claude restored message');
    });
    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
  });

  // `it.fails`: desired invariant for the behavior slice. A new local chat
  // captures the default preset at creation; changing the select before opening
  // tmux must update the session that planningChatCreate uses.
  it.fails('uses the changed preset when tmux creates a not-yet-persisted chat', async () => {
    mock.api.planningChatCreate = vi.fn(async (request?: InAppPlanningCreateSessionRequest) => ({
      ok: true,
      session: makePlanningSessionSummary({
        id: 'created-before-tmux',
        title: request?.title ?? 'Untitled plan',
        presetKey: request?.presetKey ?? 'codex',
        messages: [],
        draftPlanAvailable: false,
      }),
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), {
      target: { value: 'omp+claude' },
    });
    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));
    await waitFor(() => expect(mock.api.planningChatCreate).toHaveBeenCalledTimes(1));

    expect(mock.api.planningChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ presetKey: 'omp+claude' }),
    );
  });
});
