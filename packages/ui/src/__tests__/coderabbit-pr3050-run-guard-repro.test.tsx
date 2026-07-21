import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('CodeRabbit PR #3050 - draft review stays gated before run', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('does not submit or start work when the user only reviews the draft', async () => {
    vi.mocked(mock.api.planningChatList).mockResolvedValue({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'session-1',
          title: 'Guarded draft',
          draftPlanSummary: {
            name: 'Guarded Plan',
            taskCount: 1,
            steps: ['Review before creating workflow'],
          },
          draftPlanText: [
            'name: Guarded Plan',
            'tasks:',
            '  - id: review',
            '    description: Review before creating workflow',
            '',
          ].join('\n'),
        }),
      ],
    });

    render(<App />);

    expect(await screen.findByTestId('terminal-ready-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ready-bar-review-draft'));

    expect(await screen.findByRole('heading', { name: 'Review draft' })).toBeInTheDocument();
    expect(screen.getByText('Review before creating workflow')).toBeInTheDocument();
    expect(screen.getByTestId('draft-raw-yaml')).toHaveTextContent('name: Guarded Plan');
    expect(screen.queryByTestId('rail-start')).not.toBeInTheDocument();
    expect(mock.api.planningChatSubmit).not.toHaveBeenCalled();
    expect(mock.api.start).not.toHaveBeenCalled();
  });

  it('enables Start only after Create workflow explicitly submits the draft', async () => {
    vi.mocked(mock.api.planningChatList).mockResolvedValue({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'session-1',
          title: 'Guarded draft',
          draftPlanSummary: {
            name: 'Guarded Plan',
            taskCount: 1,
            steps: ['Review before creating workflow'],
          },
          draftPlanText: 'name: Guarded Plan\ntasks:\n  - id: review\n    description: Review before creating workflow\n',
        }),
      ],
    });
    vi.mocked(mock.api.planningChatSubmit).mockResolvedValue({
      ok: true,
      planName: 'Guarded Plan',
      workflowId: 'wf-guarded',
    });

    render(<App />);

    expect(await screen.findByTestId('terminal-ready-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ready-bar-review-draft'));
    expect(await screen.findByRole('heading', { name: 'Review draft' })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('draft-review-create-workflow'));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });
    expect(mock.api.start).not.toHaveBeenCalled();
    expect(await screen.findByTestId('rail-start')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('rail-start'));

    await waitFor(() => {
      expect(mock.api.start).toHaveBeenCalledTimes(1);
    });
  });
});
