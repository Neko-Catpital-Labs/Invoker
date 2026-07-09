import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

function makeManyChatTypingFixture(): { tasks: ReturnType<typeof makeUITask>[]; workflows: WorkflowMeta[] } {
  const workflows = Array.from({ length: 24 }, (_, index): WorkflowMeta => ({
    id: `wf-chat-${String(index).padStart(2, '0')}`,
    name: `Planning chat ${String(index + 1).padStart(2, '0')}`,
    status: 'running',
  }));
  const tasks = workflows.map((workflow, index) => makeUITask({
    id: `${workflow.id}/message-scan`,
    description: `Transcript scan for chat ${index + 1}`,
    status: 'running',
    workflowId: workflow.id,
    prompt: `Synthetic planning transcript ${index + 1}`,
  }));
  return { tasks, workflows };
}

describe('Invoker terminal planning typing telemetry baseline', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('reports a deterministic many-chats/many-messages typing baseline', async () => {
    render(<App />);
    const reportUiPerf = vi.mocked(mock.api.reportUiPerf);
    reportUiPerf.mockClear();

    const { tasks, workflows } = makeManyChatTypingFixture();
    act(() => mock.setTasks(tasks, workflows));

    await waitFor(() => {
      expect(reportUiPerf).toHaveBeenCalledWith(
        'planning_typing_lag_baseline',
        expect.objectContaining({
          baselineVersion: 1,
          scenario: 'planning_many_chats_many_messages_typing',
          sessionCount: 24,
          planningSessionCount: 24,
          messagesPerSession: 48,
          transcriptMessageCount: 1152,
          transcriptSizeMessages: 1152,
          transcriptCharCount: 138240,
          transcriptSizeChars: 138240,
          typedInputCharCount: 160,
          activeComposerState: 'typing',
          activeSurface: 'home',
          activeState: 'running',
          selectedWorkflowId: 'wf-chat-00',
          selectedTaskId: null,
          workflowCount: 24,
          taskCount: 24,
          terminalState: 'collapsed',
          renderCommitMs: expect.any(Number),
          frameDelayMs: expect.any(Number),
        }),
      );
    });
  });
});
