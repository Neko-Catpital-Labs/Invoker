import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

type PlanningChatResponse = {
  ok: boolean;
  sessionId: string;
  reply: string;
  draftPlanAvailable: boolean;
  draftPlanSummary?: {
    name: string;
    taskCount: number;
    steps: string[];
  };
};

type PlanningStreamEvent = {
  sessionId: string;
  chunk: string;
};

describe('planning stream after submitted draft repro', () => {
  let mock: MockInvoker;
  let streamCallbacks: Set<(event: PlanningStreamEvent) => void>;

  beforeEach(() => {
    streamCallbacks = new Set();
    mock = createMockInvoker();
    installPlanningApiStubs(mock);
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    streamCallbacks.clear();
  });

  function installPlanningApiStubs(mockInvoker: MockInvoker) {
    const api = mockInvoker.api as any;
    api.planningChatCreate = vi.fn(async () => ({
      ok: true,
      session: {
        id: 'session-1',
        title: 'Untitled plan',
        status: 'still_discussing',
        presetKey: 'codex',
        messages: [],
        draftPlanAvailable: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }));
    api.planningChatList = vi.fn(async () => ({ ok: true, sessions: [] }));
    api.planningChatSubmit = vi.fn(async () => ({
      ok: true,
      planName: 'Mock Plan',
      workflowId: 'wf-1',
    }));
    api.planningChatReset = vi.fn(async () => ({ ok: true }));
    api.getPlanningPresets = vi.fn(async () => [{ key: 'codex', label: 'Codex' }]);
    api.refreshTaskGraph = vi.fn(async () => ({ tasks: [], workflows: [] }));
    api.onPlanningChatStream = vi.fn((cb: (event: PlanningStreamEvent) => void) => {
      streamCallbacks.add(cb);
      return () => { streamCallbacks.delete(cb); };
    });
  }

  function firePlanningChatStream(event: PlanningStreamEvent) {
    for (const callback of streamCallbacks) {
      callback(event);
    }
  }

  async function openPlanningTerminal() {
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  it('keeps live planner output visible for a new pending turn after submitting a draft', async () => {
    const draftReply: PlanningChatResponse = {
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First', 'Second'] },
    };
    let resolveSecondSend: ((value: PlanningChatResponse) => void) | null = null;
    (mock.api as any).planningChatSend = vi
      .fn()
      .mockResolvedValueOnce(draftReply)
      .mockImplementationOnce(() => new Promise<PlanningChatResponse>((resolve) => {
        resolveSecondSend = resolve;
      }));

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the full plan');
    await screen.findByTestId('invoker-terminal-ready-bar');

    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));
    await waitFor(() => {
      expect((mock.api as any).planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    await openPlanningTerminal();
    await screen.findByText('Plan "Mock Plan" submitted to Invoker. Review it, then use Start ready work.');
    expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled();
    expect(screen.getByTestId('invoker-terminal-harness')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-input')).toBeEnabled();
    });

    submitPlanningText('draft the follow-up plan');
    await waitFor(() => {
      expect((mock.api as any).planningChatSend).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      firePlanningChatStream({ sessionId: 'session-2', chunk: 'live planner thinking' });
    });

    const streamPanel = await screen.findByTestId('invoker-terminal-planner-stream');
    expect(streamPanel).toHaveAttribute('data-state', 'streaming');
    expect(streamPanel).toHaveTextContent('live planner thinking');

    await act(async () => {
      resolveSecondSend?.({
        ok: true,
        sessionId: 'session-2',
        reply: 'Final assistant reply.',
        draftPlanAvailable: false,
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-planner-stream')).not.toBeInTheDocument();
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Final assistant reply.');
      expect(screen.getByTestId('invoker-terminal-transcript')).not.toHaveTextContent('live planner thinking');
    });
  });
});
