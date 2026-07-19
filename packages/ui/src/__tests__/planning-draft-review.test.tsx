import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning draft review', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('opens draft review in the Home sidebar without switching to the action graph', async () => {
    const session = makePlanningSessionSummary({
      draftPlanSummary: {
        name: 'Grouped plan',
        workflowCount: 2,
        taskCount: 3,
        steps: ['API workflow', 'UI workflow'],
        taskGroups: [
          { name: 'API workflow', taskCount: 1, steps: ['Add endpoint'] },
          { name: 'UI workflow', taskCount: 2, steps: ['Render sidebar', 'Wire actions'] },
        ],
      },
      draftPlanText: 'name: Grouped plan\nworkflows:\n  - name: API workflow\n',
    });
    vi.mocked(mock.api.planningChatList).mockResolvedValue({ ok: true, sessions: [session] });

    render(<App />);

    fireEvent.click(await screen.findByTestId('terminal-review-draft'));

    const panel = await screen.findByTestId('planning-context-panel');
    await waitFor(() => expect(panel).toHaveFocus());
    expect(screen.getByText('Load a plan to render workflow graph')).toBeInTheDocument();
    expect(screen.queryByTestId('action-graph-view')).not.toBeInTheDocument();
    expect(screen.getByText('API workflow')).toBeInTheDocument();
    expect(screen.getByText('Add endpoint')).toBeInTheDocument();
    expect(screen.getByText('Render sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('planning-draft-yaml')).toHaveTextContent('name: Grouped plan');
  });

  it('clears draft readiness after creating the workflow', async () => {
    const session = makePlanningSessionSummary();
    vi.mocked(mock.api.planningChatList).mockResolvedValue({ ok: true, sessions: [session] });

    render(<App />);

    fireEvent.click(await screen.findByTestId('terminal-review-draft'));
    fireEvent.click(await screen.findByTestId('planning-create-workflow'));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: session.id });
      expect(screen.queryByTestId('terminal-ready-bar')).not.toBeInTheDocument();
      expect(screen.queryByTestId('planning-context-panel')).not.toBeInTheDocument();
    });
  });
});
