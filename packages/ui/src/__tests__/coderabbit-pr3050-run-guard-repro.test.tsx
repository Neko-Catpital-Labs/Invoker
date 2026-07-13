import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningChatResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Dynamic import is required so App sees the hoisted @xyflow/react mock.
const { App } = await import('../App.js');

// Submitted planning sessions are read-only. Starting work goes through the
// graph Run button, and once a run starts the button disappears so it cannot
// call invoker.start() a second time.
describe('CodeRabbit PR #3050 — "run" respects the already-started guard', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  async function openPlanningTerminal() {
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  it('does not re-invoke start after a run has already started', async () => {
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

    submitPlanningText('draft the full plan');
    await screen.findByTestId('invoker-terminal-ready-bar');
    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));
    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledTimes(1);
    });
    await openPlanningTerminal();
    await screen.findByText('Plan "Mock Plan" submitted to Invoker. Review it, then Run.');
    fireEvent.click(screen.getByTestId('sidebar-home'));
    fireEvent.click(await screen.findByTestId('rail-start'));
    await waitFor(() => {
      expect(mock.api.start).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('rail-start')).not.toBeInTheDocument();

    await openPlanningTerminal();
    expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled();
    expect(screen.getByTestId('invoker-terminal-harness')).toBeDisabled();
    expect(mock.api.start).toHaveBeenCalledTimes(1);
  });
});
