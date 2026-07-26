import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type {
  InAppPlanningChatRequest,
  InAppPlanningChatResponse,
  TerminalSessionDescriptor,
} from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

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

describe('planning terminal preset ownership repros', () => {
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
    await ensureOptionsOpen();
  }

  async function ensureOptionsOpen() {
    if (!screen.queryByTestId('invoker-terminal-harness')) {
      fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    }
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toBeInTheDocument();
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  // `it.fails`: current renderer state stores the selected preset globally.
  // Switching back to an older chat can send the newer chat's preset.
  it.fails('restores the owning preset when switching from one chat to another chat', async () => {
    mock.api.planningChatSend = vi.fn(async (request: InAppPlanningChatRequest) => {
      const sessionId = request.sessionId
        ?? (request.presetKey === 'omp+claude' ? 'claude-chat' : 'codex-chat');
      return {
        ok: true,
        sessionId,
        reply: `Reply from ${request.presetKey ?? 'default preset'}.`,
        draftPlanAvailable: false,
      } satisfies InAppPlanningChatResponse;
    }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first codex request');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'first codex request',
        presetKey: 'codex',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await ensureOptionsOpen();
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), {
      target: { value: 'omp+claude' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
    });

    submitPlanningText('second claude request');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'second claude request',
        presetKey: 'omp+claude',
      });
    });

    const firstChatButton = within(screen.getByTestId('planning-session-list')).getByRole('button', {
      name: /first codex request/i,
    });
    fireEvent.click(firstChatButton);
    await ensureOptionsOpen();
    submitPlanningText('follow up on the codex-owned chat');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(3);
    });
    expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
      sessionId: 'codex-chat',
      message: 'follow up on the codex-owned chat',
      presetKey: 'codex',
    });
  });

  it('uses the currently selected preset when a local chat is promoted for tmux open', async () => {
    const terminalSession: TerminalSessionDescriptor = {
      sessionId: 'tmux-for-claude-preset',
      taskId: 'planning:created-for-tmux',
      kind: 'planning',
      planningSessionId: 'created-for-tmux',
      status: 'running',
      cwd: '/repo',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-26T00:00:00.000Z',
      outputSnapshot: '',
    };

    mock.api.planningChatCreate = vi.fn(async (request) => ({
      ok: true,
      session: makePlanningSessionSummary({
        id: 'created-for-tmux',
        title: request?.title ?? 'Untitled plan',
        presetKey: request?.presetKey ?? 'missing-preset',
        messages: [],
        draftPlanAvailable: false,
        terminalMode: 'chat',
      }),
    })) as any;
    mock.api.planningTerminalOpen = vi.fn(async () => ({
      opened: true,
      session: terminalSession,
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), {
      target: { value: 'omp+claude' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
        presetKey: 'omp+claude',
        title: 'Untitled plan',
      });
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('created-for-tmux');
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'tmux-for-claude-preset',
      );
    });
  });
});
