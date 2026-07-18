import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';
import type { PlanningChatSendResult } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('Invoker terminal planning drafts', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('refreshes ready bar and task list when a second planner reply returns a new draft summary', async () => {
    const firstReply: PlanningChatSendResult = {
      sessionId: 'planner-session-1',
      assistantMessage: 'First plan is ready.',
      draftPlanText: 'name: First Plan\ntasks: []\n',
      draftPlanSummary: {
        name: 'First Plan',
        taskCount: 2,
        taskGroups: [
          {
            name: 'First Group',
            tasks: [
              { id: 'first-1', description: 'First setup task' },
              { id: 'first-2', description: 'First verify task' },
            ],
          },
        ],
      },
    };
    const secondReply: PlanningChatSendResult = {
      sessionId: 'planner-session-1',
      assistantMessage: 'Second plan is ready.',
      draftPlanText: 'name: Second Plan\ntasks: []\n',
      draftPlanSummary: {
        name: 'Second Plan',
        taskCount: 3,
        taskGroups: [
          {
            name: 'Second Group',
            tasks: [
              { id: 'second-1', description: 'Second build task' },
              { id: 'second-2', description: 'Second test task' },
              { id: 'second-3', description: 'Second docs task' },
            ],
          },
        ],
      },
    };
    vi.mocked(mock.api.sendPlanningChatMessage!)
      .mockResolvedValueOnce(firstReply)
      .mockResolvedValueOnce(secondReply);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand terminal drawer' }));
    fireEvent.change(await screen.findByTestId('invoker-terminal-planner-input'), {
      target: { value: 'draft the first plan' },
    });
    fireEvent.click(screen.getByTestId('invoker-terminal-send'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('First Plan');
    });
    expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('2 tasks');
    expect(screen.getByTestId('invoker-terminal-ready-task-list')).toHaveTextContent('First Group');
    expect(screen.getByTestId('invoker-terminal-ready-task-list')).toHaveTextContent('First setup task');

    fireEvent.change(screen.getByTestId('invoker-terminal-planner-input'), {
      target: { value: 'revise the same session with a larger plan' },
    });
    fireEvent.click(screen.getByTestId('invoker-terminal-send'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('Second Plan');
    });
    const readyBar = screen.getByTestId('invoker-terminal-ready-bar');
    const taskList = screen.getByTestId('invoker-terminal-ready-task-list');
    expect(readyBar).toHaveTextContent('3 tasks');
    expect(readyBar).not.toHaveTextContent('First Plan');
    expect(taskList).toHaveTextContent('Second Group');
    expect(taskList).toHaveTextContent('Second build task');
    expect(taskList).not.toHaveTextContent('First Group');
    expect(taskList).not.toHaveTextContent('First setup task');
    expect(mock.api.sendPlanningChatMessage).toHaveBeenNthCalledWith(1, 'draft the first plan', null);
    expect(mock.api.sendPlanningChatMessage).toHaveBeenNthCalledWith(
      2,
      'revise the same session with a larger plan',
      'planner-session-1',
    );

    fireEvent.click(screen.getByTestId('invoker-terminal-submit-draft-plan'));
    await waitFor(() => {
      expect(mock.api.loadPlan).toHaveBeenCalledWith(secondReply.draftPlanText);
    });
    expect(mock.api.loadPlan).not.toHaveBeenCalledWith(firstReply.draftPlanText);
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    });
  });
});
