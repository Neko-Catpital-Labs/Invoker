import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('CodeRabbit PR #3050 - draft state cleared after explicit submit', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('reviews draft YAML and clears the ready bar only after Create workflow', async () => {
    vi.mocked(mock.api.planningChatList).mockResolvedValue({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'session-1',
          title: 'Mock draft',
          draftPlanSummary: {
            name: 'Mock Plan',
            taskCount: 2,
            steps: ['First step', 'Second step'],
          },
          draftPlanText: [
            'name: Mock Plan',
            'tasks:',
            '  - id: first',
            '    description: First step',
            '  - id: second',
            '    description: Second step',
            '',
          ].join('\n'),
        }),
      ],
    });
    vi.mocked(mock.api.planningChatSubmit).mockResolvedValue({
      ok: true,
      planName: 'Mock Plan',
      workflowId: 'wf-1',
    });

    render(<App />);

    expect(await screen.findByTestId('terminal-ready-bar')).toHaveTextContent('Mock Plan');

    fireEvent.click(screen.getByTestId('ready-bar-review-draft'));

    expect(await screen.findByRole('heading', { name: 'Review draft' })).toBeInTheDocument();
    expect(mock.api.planningChatSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('draft-step-summary')).toHaveLength(2);
    expect(screen.getByText('First step')).toBeInTheDocument();
    expect(screen.getByText('Second step')).toBeInTheDocument();
    expect(screen.getByTestId('draft-raw-yaml')).toHaveTextContent('name: Mock Plan');
    expect(screen.getByTestId('draft-raw-yaml')).toHaveTextContent('description: Second step');

    fireEvent.click(screen.getByTestId('draft-review-create-workflow'));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('terminal-ready-bar')).not.toBeInTheDocument();
    });
  });
});
