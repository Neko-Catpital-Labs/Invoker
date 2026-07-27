import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning terminal preset ownership repro', () => {
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
    if (!screen.queryByTestId('invoker-terminal-harness')) {
      fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    }
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toBeInTheDocument();
    });
  }

  it('keeps each restored chat-to-chat preset attached to its owning session', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'codex-chat',
          title: 'Codex chat',
          presetKey: 'codex',
          draftPlanAvailable: false,
          messages: [
            { id: 1, role: 'assistant', text: 'Codex transcript', createdAt: '2026-07-07T00:00:00.000Z' },
          ],
        }),
        makePlanningSessionSummary({
          id: 'claude-chat',
          title: 'Claude chat',
          presetKey: 'omp+claude',
          draftPlanAvailable: false,
          messages: [
            { id: 1, role: 'assistant', text: 'Claude transcript', createdAt: '2026-07-07T00:00:00.000Z' },
          ],
        }),
      ],
    }));

    render(<App />);
    await openPlanningTerminal();

    const rail = await screen.findByTestId('planning-session-list');
    await waitFor(() => expect(within(rail).getByText('Claude chat')).toBeInTheDocument());
    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');

    fireEvent.click(within(rail).getByText('Claude chat'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
    });

    fireEvent.click(within(rail).getByText('Codex chat'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  });

  it('uses a local preset change when the first tmux open creates the planning session', async () => {
    mock.api.planningChatCreate = vi.fn(async (request) => ({
      ok: true,
      session: makePlanningSessionSummary({
        id: 'created-omp-claude-chat',
        title: request?.title ?? 'Untitled plan',
        status: 'still_discussing',
        presetKey: request?.presetKey ?? 'codex',
        confirmationMode: request?.confirmationMode ?? 'require',
        messages: [],
        draftPlanAvailable: false,
      }),
    })) as any;
    mock.api.planningTerminalOpen = vi.fn(async (planningSessionId: string) => ({
      opened: true,
      session: {
        sessionId: 'term-created-omp-claude-chat',
        taskId: `planning:${planningSessionId}`,
        kind: 'planning',
        planningSessionId,
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: '2026-07-07T00:00:00.000Z',
      },
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
        presetKey: 'omp+claude',
        title: 'Untitled plan',
        confirmationMode: 'require',
      });
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('created-omp-claude-chat');
    });
    expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', 'term-created-omp-claude-chat');
  });
});
