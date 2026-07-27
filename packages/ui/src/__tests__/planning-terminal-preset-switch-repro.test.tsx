import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { PlanningPresetOption } from '@invoker/contracts';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

const presets: PlanningPresetOption[] = [
  { key: 'codex', label: 'Codex', tool: 'codex', isDefault: true, defaultConfirmationMode: 'require' },
  { key: 'omp+claude', label: 'Claude via OMP', tool: 'omp', model: 'claude', isDefault: false, defaultConfirmationMode: 'require' },
];

// Expected failure: preset selection is currently global enough that late
// default hydration can detach the active chat from the preset the user selected
// for that chat. The tmux-open path is kept as adjacent green coverage for the
// related pre-persisted preset handoff.
describe('planning terminal preset switch repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it.fails('keeps chat B preset ownership when preset defaults hydrate after switching from chat A', async () => {
    const presetsHydrate = deferred<PlanningPresetOption[]>();
    const codexChat = makePlanningSessionSummary({
      id: 'chat-codex',
      title: 'Codex chat',
      status: 'still_discussing',
      presetKey: 'codex',
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      draftPlanText: undefined,
      messages: [
        { id: 1, role: 'user', text: 'Codex question', createdAt: '2026-07-07T00:00:01.000Z' },
      ],
    });
    const claudeChat = makePlanningSessionSummary({
      id: 'chat-claude',
      title: 'Claude chat',
      status: 'still_discussing',
      presetKey: 'omp+claude',
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      draftPlanText: undefined,
      messages: [
        { id: 1, role: 'user', text: 'Claude question', createdAt: '2026-07-07T00:00:02.000Z' },
      ],
    });

    mock.api.getPlanningPresets = vi.fn(() => presetsHydrate.promise) as any;
    mock.api.planningChatList = vi.fn(async () => ({ ok: true, sessions: [codexChat, claudeChat] }));

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    fireEvent.click(await screen.findByText('Claude chat'));
    expect(await screen.findByText('Claude question')).toBeInTheDocument();

    await act(async () => {
      presetsHydrate.resolve(presets);
      await Promise.resolve();
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
    });

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'continue this chat' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        sessionId: 'chat-claude',
        message: 'continue this chat',
        presetKey: 'omp+claude',
        confirmationMode: 'require',
      });
    });
  });

  it('uses the newly selected preset when tmux is opened before a local chat has a persisted id', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
      fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));
    });

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalled();
    });
    expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
      presetKey: 'omp+claude',
      title: 'Untitled plan',
      confirmationMode: 'require',
    });
  });
});
