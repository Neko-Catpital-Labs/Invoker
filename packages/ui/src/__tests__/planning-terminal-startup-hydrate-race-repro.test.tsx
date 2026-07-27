import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse } from '@invoker/contracts';
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
    open = vi.fn((host: HTMLElement) => {
      const terminalElement = document.createElement('div');
      terminalElement.className = 'xterm';
      host.appendChild(terminalElement);
    });
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

describe('planning terminal startup hydrate race repro', () => {
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
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  it('reproduces a delayed startup hydrate replacing the first local send', async () => {
    const listResolvers: Array<(value: InAppPlanningListSessionsResponse) => void> = [];
    mock.api.planningChatList = vi.fn(() => new Promise<InAppPlanningListSessionsResponse>((resolve) => {
      listResolvers.push(resolve);
    }));
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'new-session-from-first-send',
      reply: 'First send reply that should remain selected.',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first message before startup hydrate resolves');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'first message before startup hydrate resolves',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('First send reply that should remain selected.');
    });
    expect(listResolvers).toHaveLength(2);

    await act(async () => {
      for (const resolve of listResolvers) {
        resolve({
          ok: true,
          sessions: [
            makePlanningSessionSummary({
              id: 'restored-session-from-startup',
              title: 'Restored startup session',
              status: 'still_discussing',
              draftPlanAvailable: false,
              messages: [
                {
                  id: 1,
                  role: 'assistant',
                  text: 'Restored transcript won the hydrate race.',
                  createdAt: '2026-07-07T00:00:01.000Z',
                },
              ],
            }),
          ],
        });
      }
    });

    await waitFor(() => {
      const transcript = screen.getByTestId('invoker-terminal-transcript');
      expect(transcript).toHaveTextContent('Restored transcript won the hydrate race.');
      expect(transcript).not.toHaveTextContent('First send reply that should remain selected.');
    });
  });
});
