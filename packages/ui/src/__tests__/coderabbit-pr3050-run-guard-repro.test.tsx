import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningChatResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('CodeRabbit PR #3050 — submitted planning stays read-only after start ready', () => {
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

  it('keeps the submitted planning session read-only after start ready work fires', async () => {
    const draftReply: InAppPlanningChatResponse = {
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First', 'Second'] },
    };
    mock.api.planningChatSend = vi.fn(async () => draftReply);

    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'draft the full plan' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
    await screen.findByTestId('invoker-terminal-ready-bar');
    fireEvent.click(screen.getByRole('button', { name: 'Review draft' }));
    fireEvent.click(await screen.findByTestId('planning-create-workflow'));
    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledTimes(1);
    });

    await openPlanningTerminal();
    await screen.findByText('Plan "Mock Plan" submitted to Invoker. Review it, then use Start ready work.');

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    fireEvent.click(await screen.findByTestId('rail-start-ready'));
    await waitFor(() => {
      expect(mock.api.startReady).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('rail-start')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rail-stop')).not.toBeInTheDocument();

    await openPlanningTerminal();
    expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled();
    expect(screen.getByTestId('invoker-terminal-harness')).toBeDisabled();
    expect(mock.api.start).not.toHaveBeenCalled();
  });
});
