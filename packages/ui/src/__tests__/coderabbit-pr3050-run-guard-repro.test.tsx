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

// CodeRabbit PR #3050 (discussion r3523490880): the "run" text command called
// handleStart() directly, guarded only by `!hasLoadedPlan`. Unlike the Start
// button (`showStart = hasLoadedPlan && !hasStarted`) it omitted the `hasStarted`
// check, so typing "run" again after a run already started re-invoked
// invoker.start(). This repro starts a run, then types "run" again and asserts
// start() is not called a second time. Buggy code fires start() twice -> FAIL.
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
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });

    submitPlanningText('draft the full plan');
    await screen.findByTestId('invoker-terminal-ready-bar');
    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));
    await screen.findByText('Plan "Mock Plan" submitted to Invoker. Review it, then Run.');

    submitPlanningText('run');
    await waitFor(() => {
      expect(mock.api.start).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Run started.')).toBeInTheDocument();
    });

    // Run is already in progress; a second "run" must be rejected, not fire start again.
    submitPlanningText('run');
    await screen.findByText('Run already started.');
    expect(mock.api.start).toHaveBeenCalledTimes(1);
  });
});
