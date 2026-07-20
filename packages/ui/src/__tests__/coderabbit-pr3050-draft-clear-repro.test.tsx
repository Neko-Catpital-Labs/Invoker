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

// CodeRabbit PR #3050 (discussion r3523490877): after `planningChatSubmit`
// succeeds, `draftPlanAvailable` / `draftPlanSummary` were never cleared, so the
// "Submit to Invoker" ready bar stayed mounted and could resubmit the same
// planning session. This repro submits a ready draft and asserts the ready bar is
// dismissed afterward. Buggy code leaves it visible -> waitFor times out -> FAIL.
describe('CodeRabbit PR #3050 — draft state cleared after submit', () => {
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
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  it('dismisses the ready bar after a successful submit', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));
    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledTimes(1);
    });
    await openPlanningTerminal();
    await screen.findByText('Plan "Mock Plan" submitted to Invoker. Review it, then use Start ready work.');
    // The submit succeeded; the ready bar must be gone so it cannot resubmit the same session.
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    });
    expect(mock.api.planningChatSubmit).toHaveBeenCalledTimes(1);
  });
});
