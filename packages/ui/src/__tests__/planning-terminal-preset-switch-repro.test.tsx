import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { InAppPlanningCreateSessionResponse, TerminalSessionDescriptor } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

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

describe('planning terminal preset switch repros', () => {
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

  function makePlanningTerminalSession(planningSessionId: string): TerminalSessionDescriptor {
    return {
      sessionId: `terminal-${planningSessionId}`,
      taskId: `planning:${planningSessionId}`,
      kind: 'planning',
      planningSessionId,
      status: 'running',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-07T00:00:00.000Z',
      outputSnapshot: '',
    };
  }

  it('reproduces chat-to-chat preset leakage back into the startup chat', async () => {
    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
    });

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => {
      expect(within(screen.getByTestId('planning-session-list')).getAllByRole('button')).toHaveLength(2);
    });

    const sessionRows = within(screen.getByTestId('planning-session-list')).getAllByRole('button');
    fireEvent.click(sessionRows[1]!);

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
    });
    submitPlanningText('send from the original startup chat');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'send from the original startup chat',
        presetKey: 'omp+claude',
        confirmationMode: 'require',
      });
    });
  });

  it('exercises a preset change immediately before tmux open through the create-session bridge', async () => {
    mock.api.planningChatCreate = vi.fn(async (request) => ({
      ok: true,
      session: makePlanningSessionSummary({
        id: 'created-for-tmux',
        title: 'Created for tmux',
        status: 'still_discussing',
        presetKey: request?.presetKey ?? 'codex',
        confirmationMode: request?.confirmationMode ?? 'require',
        messages: [],
        draftPlanAvailable: false,
      }),
    } satisfies InAppPlanningCreateSessionResponse)) as any;
    mock.api.planningTerminalOpen = vi.fn(async (planningSessionId: string) => ({
      opened: true,
      session: makePlanningTerminalSession(planningSessionId),
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    await act(async () => {
      fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
      fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));
    });

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledTimes(1);
    });
    expect(mock.api.planningChatCreate).toHaveBeenCalledWith(expect.objectContaining({
      presetKey: 'omp+claude',
      title: 'Untitled plan',
      confirmationMode: 'require',
    }));
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('created-for-tmux');
  });
});
