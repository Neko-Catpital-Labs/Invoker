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
    open = vi.fn((host: HTMLElement) => {
      const terminalElement = document.createElement('div');
      terminalElement.className = 'xterm';
      host.appendChild(terminalElement);
    });
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

describe('planning terminal preset switching repros', () => {
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

  it('reproduces chat-to-chat preset ownership while switching active conversations', async () => {
    mock.api.planningChatSend = vi.fn(async (request: { message: string; presetKey?: string }) => {
      const response: InAppPlanningChatResponse = {
        ok: true,
        sessionId: request.message.includes('second') ? 'session-omp' : 'session-codex',
        reply: `${request.presetKey ?? 'missing'} reply`,
        confirmationMode: 'require',
        draftPlanAvailable: false,
      };
      return response;
    }) as any;

    render(<App />);
    await openOptions();

    submitPlanningText('first codex chat');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('codex reply');
    });

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-input')).toHaveValue('');
    });
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
    });

    submitPlanningText('second omp chat');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('omp+claude reply');
    });

    fireEvent.click(screen.getByTitle('first codex chat').closest('button')!);
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });

    fireEvent.click(screen.getByTitle('second omp chat').closest('button')!);
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
    });
  });

  it('exercises a preset change immediately before opening tmux for an unsent chat', async () => {
    mock.api.planningChatCreate = vi.fn(async (request: { presetKey?: string; title?: string }) => ({
      ok: true,
      session: {
        id: 'created-before-tmux',
        title: request.title ?? 'Untitled plan',
        status: 'still_discussing',
        presetKey: request.presetKey ?? 'missing',
        confirmationMode: 'require',
        messages: [],
        draftPlanAvailable: false,
        terminalMode: 'chat',
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
      },
    })) as any;

    render(<App />);
    await openOptions();

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
        presetKey: 'omp+claude',
        title: 'Untitled plan',
        confirmationMode: 'require',
      });
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('created-before-tmux');
    });
  });
});
