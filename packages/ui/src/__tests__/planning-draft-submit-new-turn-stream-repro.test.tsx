import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningChatResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Dynamic import is required so App sees the hoisted @xyflow/react mock.
const { App } = await import('../App.js');

// Regression repro: after submitting a draft-ready planning session, starting a
// new planning turn must still show the live raw planner stream while the new
// planningChatSend request is pending. Buggy code loses the stream surface until
// the final assistant reply arrives.
describe('planning draft submit -> new turn live planner stream repro', () => {
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

  it('keeps live planner output visible during the new pending turn after submit', async () => {
    let resolveSecondSend: ((value: InAppPlanningChatResponse) => void) | null = null;
    const draftReply: InAppPlanningChatResponse = {
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First', 'Second'] },
    };

    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce(draftReply)
      .mockImplementationOnce(() => new Promise<InAppPlanningChatResponse>((resolve) => {
        resolveSecondSend = resolve;
      })) as any;
    mock.api.planningChatSubmit = vi.fn(async () => ({
      ok: true,
      planName: 'Mock Plan',
      workflowId: 'wf-1',
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the full plan');
    await screen.findByTestId('invoker-terminal-ready-bar');
    fireEvent.click(screen.getByRole('button', { name: 'Review draft' }));
    fireEvent.click(await screen.findByTestId('planning-create-workflow'));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });
    await openPlanningTerminal();
    expect(await screen.findByText('Plan "Mock Plan" submitted to Invoker. Review it, then use Start ready work.')).toBeInTheDocument();
    expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled();
    expect(screen.getByTestId('invoker-terminal-harness')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-input')).not.toBeDisabled();
    });

    submitPlanningText('draft the next plan');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        message: 'draft the next plan',
        presetKey: 'codex',
      });
    });

    await act(async () => {
      mock.firePlanningChatStream({ sessionId: 'session-2', chunk: 'live planner thinking after submit' });
    });

    const stream = await screen.findByTestId('invoker-terminal-planner-stream');
    expect(stream).toHaveAttribute('data-state', 'streaming');
    expect(stream).toHaveTextContent('Drafting your plan…');

    await act(async () => {
      resolveSecondSend?.({
        ok: true,
        sessionId: 'session-2',
        reply: 'Final assistant reply for the new turn.',
        draftPlanAvailable: false,
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-planner-stream')).not.toBeInTheDocument();
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Final assistant reply for the new turn.');
    });
  });
});
