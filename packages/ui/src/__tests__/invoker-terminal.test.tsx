import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { useState } from 'react';
import { createMockInvoker, makePlanningSessionSummary, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { TaskState, WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Dynamic imports are required so modules see the hoisted @xyflow/react mock.
const { App } = await import('../App.js');
const { InvokerTerminal } = await import('../components/InvokerTerminal.js');

const COMPONENT_INPUT_HANDLER_BUDGET_MS = 16;

describe('Invoker terminal (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

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

  function expectRailListScrollContract(list: HTMLElement) {
    expect(list).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(list.parentElement).toHaveClass('flex', 'min-h-0', 'flex-1', 'flex-col');
  }

  function expectSubmittedPlanningSurfaceVisible() {
    expect(screen.getByTestId('sidebar-planning')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Planning chat window' })).toBeInTheDocument();
    expect(screen.queryByText('Plan graph')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit to Invoker' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry submit' })).not.toBeInTheDocument();
  }

  async function expectSurfaceRailList(surface: 'planning' | 'workflows' | 'attention', listTestId: string) {
    fireEvent.click(await screen.findByTestId(`sidebar-${surface}`));
    await waitFor(() => {
      expect(screen.getByTestId(`sidebar-${surface}`)).toHaveAttribute('aria-current', 'page');
    });
    expectRailListScrollContract(await screen.findByTestId(listTestId));
  }

  it('renders an empty flush planning pane before the first message', async () => {
    render(<App />);
    await openPlanningTerminal();

    expect(screen.getByRole('heading', { name: 'Planning chat window' })).toBeInTheDocument();
    expect(screen.getByText('Still discussing')).toBeInTheDocument();
    expect(screen.queryByText('What do you want to build?')).not.toBeInTheDocument();
    expect(screen.queryByText('Talk it through, then submit the plan to Invoker.')).not.toBeInTheDocument();
    expect(screen.queryByText('Ask Invoker what you want to build.')).not.toBeInTheDocument();
    const transcript = screen.getByTestId('invoker-terminal-transcript');
    expect(transcript).toBeEmptyDOMElement();
    const terminalShell = transcript.closest('section');
    expect(terminalShell).not.toBeNull();
    expect(terminalShell?.className).not.toContain('border border-border');
    expect(terminalShell?.className).not.toContain('bg-card');
    expect(screen.getByTestId('invoker-terminal-input')).toBeEnabled();
  });

  function lastPerfPayload(metric: string): Record<string, any> {
    const payload = vi.mocked(mock.api.reportUiPerf).mock.calls
      .filter(([name]) => name === metric)
      .map(([, data]) => data as Record<string, any>)
      .at(-1);
    if (!payload) throw new Error(`Missing ${metric} perf payload`);
    return payload;
  }

  function makeManyWorkflowTypingBaseline(
    workflowCount = 8,
    messagesPerWorkflow = 12,
  ): { tasks: TaskState[]; workflows: WorkflowMeta[] } {
    const tasks: TaskState[] = [];
    const workflows: WorkflowMeta[] = [];

    for (let workflowIndex = 0; workflowIndex < workflowCount; workflowIndex += 1) {
      const workflowId = `wf-chat-${workflowIndex}`;
      workflows.push({
        id: workflowId,
        name: `Planning Chat ${workflowIndex}`,
        status: 'running',
      });

      for (let messageIndex = 0; messageIndex < messagesPerWorkflow; messageIndex += 1) {
        const messageId = `message-${String(messageIndex).padStart(2, '0')}`;
        const previousMessageId = `message-${String(messageIndex - 1).padStart(2, '0')}`;
        tasks.push(makeUITask({
          id: `${workflowId}/${messageId}`,
          description: `Planning transcript message ${workflowIndex}.${messageIndex}`,
          status: 'pending',
          workflowId,
          dependencies: messageIndex === 0 ? [] : [`${workflowId}/${previousMessageId}`],
          prompt: [
            `session=${workflowIndex}`,
            `message=${messageIndex}`,
            `content=${'planning-context '.repeat(8)}${workflowIndex}-${messageIndex}`,
          ].join('\n'),
          execution: {
            agentSessionId: `session-${workflowIndex}`,
          },
        }));
      }
    }

    return { tasks, workflows };
  }

  function expectedTranscriptMessageCount(tasks: TaskState[]): number {
    return tasks.reduce((total, task) => (
      total + (task.config.prompt?.split(/\n+/).filter((line) => line.trim().length > 0).length ?? 0)
    ), 0);
  }

  function terminalProps(overrides: Partial<Parameters<typeof InvokerTerminal>[0]> = {}) {
    return {
      activeConversationKey: 'chat-1',
      lines: [{ id: 1, text: 'First line', role: 'system' as const }],
      busy: false,
      value: '',
      selectedPresetKey: 'codex',
      presetOptions: [{ key: 'codex', label: 'Codex' }],
      draftPlanAvailable: false,
      onValueChange: vi.fn(),
      onSubmit: vi.fn(),
      onSubmitDraft: vi.fn(),
      onPresetChange: vi.fn(),
      onExpand: vi.fn(),
      ...overrides,
    };
  }

  it('generates a planning reply from plain language', async () => {
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('hello');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({ message: 'hello', presetKey: 'codex' });
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('I can help draft that.');
    });
    expect(screen.queryByText(/Unknown command/)).not.toBeInTheDocument();
  });

  it('shows live raw planner output while busy and removes it when the final reply arrives', async () => {
    let resolveSend: ((value: any) => void) | null = null;
    mock.api.planningChatSend = vi.fn(() => new Promise((resolve) => {
      resolveSend = resolve;
    }) as any) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft a streamed plan');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));

    await act(async () => {
      mock.firePlanningChatStream({ sessionId: 'session-1', chunk: 'raw planner ' });
      mock.firePlanningChatStream({ sessionId: 'session-1', chunk: 'text' });
    });

    const panel = await screen.findByTestId('invoker-terminal-planner-stream');
    expect(panel).toHaveAttribute('data-state', 'streaming');
    expect(panel).toHaveTextContent('raw planner text');

    await act(async () => {
      resolveSend?.({
        ok: true,
        sessionId: 'session-1',
        reply: 'Final assistant reply.',
        draftPlanAvailable: false,
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-planner-stream')).not.toBeInTheDocument();
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Final assistant reply.');
      expect(screen.getByTestId('invoker-terminal-transcript')).not.toHaveTextContent('raw planner text');
    });
  });

  it('keeps failed raw planner output visible until the next send starts', async () => {
    const plannerError = 'planner exited with code 1';
    let resolveFirstSend: ((value: any) => void) | null = null;
    let resolveSecondSend: ((value: any) => void) | null = null;
    mock.api.planningChatSend = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstSend = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecondSend = resolve;
      })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft a failing streamed plan');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));
    await act(async () => {
      mock.firePlanningChatStream({ sessionId: 'session-1', chunk: 'partial raw output' });
    });
    expect(await screen.findByTestId('invoker-terminal-planner-stream')).toHaveTextContent('partial raw output');

    await act(async () => {
      resolveFirstSend?.({ ok: false, sessionId: 'session-1', error: plannerError });
    });

    await waitFor(() => {
      const panel = screen.getByTestId('invoker-terminal-planner-stream');
      expect(panel).toHaveAttribute('data-state', 'failed');
      expect(panel).toHaveTextContent('partial raw output');
      expect(panel).toHaveTextContent(plannerError);
    });

    submitPlanningText('try again');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('invoker-terminal-planner-stream')).not.toBeInTheDocument();
    });

    await act(async () => {
      resolveSecondSend?.({
        ok: true,
        sessionId: 'session-2',
        reply: 'Recovered.',
        draftPlanAvailable: false,
      });
    });
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Recovered.'));
  });

  it('keeps live planner output isolated when switching planning sessions', async () => {
    mock.api.planningChatSend = vi.fn(() => new Promise(() => {}) as any) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first session request');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));
    await act(async () => {
      mock.firePlanningChatStream({ sessionId: 'session-1', chunk: 'first raw stream' });
    });
    expect(await screen.findByTestId('invoker-terminal-planner-stream')).toHaveTextContent('first raw stream');

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(screen.queryByTestId('invoker-terminal-planner-stream')).not.toBeInTheDocument();

    submitPlanningText('second session request');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2));
    await act(async () => {
      mock.firePlanningChatStream({ sessionId: 'session-2', chunk: 'second raw stream' });
    });

    const secondPanel = await screen.findByTestId('invoker-terminal-planner-stream');
    expect(secondPanel).toHaveTextContent('second raw stream');
    expect(secondPanel).not.toHaveTextContent('first raw stream');

    const sessionButtons = within(screen.getByTestId('planning-session-list')).getAllByRole('button');
    fireEvent.click(sessionButtons[1]);

    const firstPanel = await screen.findByTestId('invoker-terminal-planner-stream');
    expect(firstPanel).toHaveTextContent('first raw stream');
    expect(firstPanel).not.toHaveTextContent('second raw stream');
  });

  it('shows collapsed Thinking disclosure when reasoning is present', async () => {
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'Hello. What should we plan?',
      reasoning: 'Greet the user and ask what to plan.',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    submitPlanningText('hello');

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Hello. What should we plan?');
    });
    const thinking = screen.getByTestId('invoker-terminal-thinking');
    expect(thinking).toBeInTheDocument();
    expect(thinking).not.toHaveAttribute('open');
    expect(thinking).toHaveTextContent('Thinking');
    expect(thinking).toHaveTextContent('Greet the user and ask what to plan.');
    expect(screen.queryByText('thread.started')).not.toBeInTheDocument();
  });

  it('sends plain language when Enter is pressed', async () => {
    render(<App />);
    await openPlanningTerminal();

    const input = screen.getByTestId('invoker-terminal-input');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({ message: 'hello', presetKey: 'codex' });
    });
  });

  it('shows the wait cursor only while a planning request is busy', async () => {
    let resolveSend: ((value: any) => void) | null = null;
    mock.api.planningChatSend = vi.fn(() => {
      return new Promise((resolve) => {
        resolveSend = resolve;
      }) as any;
    }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft a plan');

    const input = screen.getByTestId('invoker-terminal-input');
    await waitFor(() => expect(input).toBeDisabled());
    expect(input).toHaveClass('disabled:cursor-wait');
    expect(input).not.toHaveClass('disabled:cursor-not-allowed');

    await act(async () => {
      resolveSend?.({ ok: true, sessionId: 'session-1', reply: 'Done.', draftPlanAvailable: false });
    });
  });

  it('reports planning chat input, submit, and transcript render perf markers', async () => {
    const props = {
      activeConversationKey: 'chat-1',
      lines: [{ id: 1, text: 'First line', role: 'system' as const }],
      busy: false,
      value: '',
      selectedPresetKey: 'codex',
      presetOptions: [{ key: 'codex', label: 'Codex' }],
      draftPlanAvailable: false,
      onValueChange: vi.fn(),
      onSubmit: vi.fn(),
      onSubmitDraft: vi.fn(),
      onPresetChange: vi.fn(),
      onExpand: vi.fn(),
    };
    const { rerender } = render(<InvokerTerminal {...props} />);
    vi.mocked(mock.api.reportUiPerf).mockClear();

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'hello' } });
    expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
      'planning_chat_input_change',
      expect.objectContaining({
        valueLength: 5,
        previousValueLength: 0,
        deltaLength: 5,
        conversationKey: 'chat-1',
        transcriptLineCount: 1,
      }),
    );

    rerender(<InvokerTerminal {...props} value="hello" />);
    await waitFor(() => {
      expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
        'planning_chat_input_commit',
        expect.objectContaining({
          valueLength: 5,
          previousValueLength: 0,
          deltaLength: 5,
          conversationKey: 'chat-1',
          transcriptLineCount: 1,
        }),
      );
    });

    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
    expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
      'planning_chat_submit',
      expect.objectContaining({
        source: 'form',
        valueLength: 5,
        trimmedLength: 5,
        conversationKey: 'chat-1',
      }),
    );

    rerender(<InvokerTerminal
      {...props}
      value="hello"
      lines={[...props.lines, { id: 2, text: 'Second line', role: 'assistant' as const }]}
    />);
    await waitFor(() => {
      expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
        'planning_chat_transcript_commit',
        expect.objectContaining({
          conversationKey: 'chat-1',
          lineCount: 2,
          lineDelta: 1,
          transcriptChars: 'First lineSecond line'.length,
          lastLineRole: 'assistant',
        }),
      );
    });
  });

  it('keeps typing responsive under a large existing transcript', async () => {
    const largeTranscript = Array.from({ length: 360 }, (_, index) => ({
      id: index + 1,
      text: `pressure transcript line ${index + 1}: ${'renderer output '.repeat(12)}`,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    }));

    function Harness(): JSX.Element {
      const [value, setValue] = useState('');
      return (
        <InvokerTerminal
          activeConversationKey="large-chat"
          lines={largeTranscript}
          busy={false}
          value={value}
          selectedPresetKey="codex"
          presetOptions={[{ key: 'codex', label: 'Codex' }]}
          draftPlanAvailable={false}
          onValueChange={setValue}
          onSubmit={vi.fn()}
          onSubmitDraft={vi.fn()}
          onPresetChange={vi.fn()}
          onExpand={vi.fn()}
        />
      );
    }

    render(<Harness />);
    vi.mocked(mock.api.reportUiPerf).mockClear();

    const nextValue = 'tighten terminal responsiveness assertions';
    const input = screen.getByTestId('invoker-terminal-input');
    fireEvent.change(input, { target: { value: nextValue } });

    await waitFor(() => expect(input).toHaveValue(nextValue));
    await waitFor(() => {
      expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
        'planning_chat_input_commit',
        expect.objectContaining({
          valueLength: nextValue.length,
          previousValueLength: 0,
          conversationKey: 'large-chat',
          transcriptLineCount: largeTranscript.length,
        }),
      );
    });

    const changePayload = lastPerfPayload('planning_chat_input_change');
    expect(changePayload.handlerDurationMs).toBeLessThanOrEqual(COMPONENT_INPUT_HANDLER_BUDGET_MS);
    expect(changePayload.transcriptLineCount).toBe(largeTranscript.length);

    const commitPayload = lastPerfPayload('planning_chat_input_commit');
    expect(Number.isFinite(commitPayload.durationMs)).toBe(true);
    expect(commitPayload.durationMs).toBeGreaterThanOrEqual(0);
    expect(commitPayload.transcriptLineCount).toBe(largeTranscript.length);

    const transcriptCommitsAfterTyping = vi.mocked(mock.api.reportUiPerf).mock.calls
      .filter(([metric]) => metric === 'planning_chat_transcript_commit');
    expect(transcriptCommitsAfterTyping).toHaveLength(0);
  });

  it('reports a many-workflow planning typing lag baseline from the task prompt editor', async () => {
    const { tasks, workflows } = makeManyWorkflowTypingBaseline();
    render(<App />);

    act(() => mock.setTasks(tasks, workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-chat-0')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('workflow-node-wf-chat-0'));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-wf-chat-0/message-00')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('rf__node-wf-chat-0/message-00'));

    await waitFor(() => {
      expect(screen.getByTestId('prompt-command-display')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('prompt-command-display'));

    const promptInput = await screen.findByTestId('edit-prompt-input') as HTMLTextAreaElement;
    const reportUiPerf = vi.mocked(mock.api.reportUiPerf);
    reportUiPerf.mockClear();

    const nextPrompt = `${promptInput.value}\noperator typed follow-up`;
    fireEvent.change(promptInput, { target: { value: nextPrompt } });

    await waitFor(() => {
      expect(reportUiPerf.mock.calls.some(([metric]) => metric === 'planning_typing_lag_baseline')).toBe(true);
    });

    const payload = lastPerfPayload('planning_typing_lag_baseline');
    expect(payload).toEqual(expect.objectContaining({
      scenario: 'many-chats-many-messages-typing',
      sessionCount: workflows.length,
      transcriptMessageCount: expectedTranscriptMessageCount(tasks),
      taskCount: tasks.length,
      workflowCount: workflows.length,
      taskStatusCounts: { pending: tasks.length },
      activeSurface: 'planning',
      activeState: 'dag:task_selected:terminal-minimized',
      viewMode: 'dag',
      terminalDrawerState: 'minimized',
      selectionState: 'task_selected',
      selectedTaskId: 'wf-chat-0/message-00',
      selectedWorkflowId: 'wf-chat-0',
      targetName: 'edit-prompt-input',
      targetTagName: 'textarea',
      targetValueLength: nextPrompt.length,
      targetReadOnly: false,
      targetDisabled: false,
      targetIsComposing: false,
      eventType: 'change',
      lagMs: expect.any(Number),
    }));
    expect(payload.transcriptSizeBytes).toBeGreaterThan(10_000);
  });

  it('hydrates restored planning chats and keeps the restored session editable', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'saved-pressure-chat',
          title: 'Saved pressure chat',
          status: 'still_discussing',
          presetKey: 'codex',
          messages: [
            {
              id: 1,
              role: 'system',
              text: 'Ask Invoker what you want to build.',
              tone: 'muted',
              createdAt: '2026-07-07T00:00:00.000Z',
            },
            {
              id: 2,
              role: 'user',
              text: 'Keep this restored transcript editable',
              createdAt: '2026-07-07T00:00:01.000Z',
            },
            {
              id: 3,
              role: 'assistant',
              text: 'The restored transcript is ready.',
              createdAt: '2026-07-07T00:00:02.000Z',
            },
          ],
          draftPlanAvailable: false,
        }),
      ],
    }));

    render(<App />);
    await openPlanningTerminal();

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('The restored transcript is ready.');
    });
    expect(screen.getByTestId('invoker-terminal-input')).toBeEnabled();

    submitPlanningText('continue the restored session');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        sessionId: 'saved-pressure-chat',
        message: 'continue the restored session',
        presetKey: 'codex',
      });
    });
  });

  it('counts only attention-worthy planning sessions in the sidebar badge', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'idle-chat',
          title: 'Idle chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
        }),
        makePlanningSessionSummary({
          id: 'draft-chat',
          title: 'Draft ready chat',
          status: 'draft_ready',
          draftPlanAvailable: true,
        }),
        makePlanningSessionSummary({
          id: 'waiting-chat',
          title: 'Waiting chat',
          status: 'waiting_for_answer',
          draftPlanAvailable: false,
        }),
        makePlanningSessionSummary({
          id: 'submitted-chat',
          title: 'Submitted chat',
          status: 'submitted',
          draftPlanAvailable: false,
        }),
      ],
    }));

    render(<App />);

    const planningButton = await screen.findByTestId('sidebar-planning');
    await waitFor(() => {
      expect(within(planningButton).getByText('2')).toBeInTheDocument();
    });

    fireEvent.click(planningButton);

    expect(await screen.findByText('4 planning chats.')).toBeInTheDocument();
    expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('4 chats');
  });

  it('keeps the Planning Terminal attention count unchanged when creating an idle chat', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    render(<App />);

    const planningButton = await screen.findByTestId('sidebar-planning');
    await waitFor(() => {
      expect(within(planningButton).getByText('0')).toBeInTheDocument();
    });

    fireEvent.click(planningButton);

    expect(await screen.findByText('1 planning chat.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    await waitFor(() => {
      expect(screen.getByText('2 planning chats.')).toBeInTheDocument();
    });
    expect(within(screen.getByTestId('sidebar-planning')).getByText('0')).toBeInTheDocument();
    expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('2 chats');
  });

  it('continues the same planning session', async () => {
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('hello');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1);
    });

    submitPlanningText('make the plan more detailed');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'session-1',
        message: 'make the plan more detailed',
        presetKey: 'codex',
      });
    });
  });

  it('passes the selected planning preset', async () => {
    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    submitPlanningText('draft a plan');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({ message: 'draft a plan', presetKey: 'omp+claude' });
    });
  });

  it('shows the sticky ready bar and submits without starting execution', async () => {
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First', 'Second'] },
    })) as any;
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the full plan');

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('draft ready · "Mock Plan" · 2 tasks');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'session-1' });
      expect(mock.api.refreshTaskGraph).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Plan "Mock Plan" submitted to Invoker. Review it, then use Start ready work.');
      expectSubmittedPlanningSurfaceVisible();
    });
    expect(mock.api.start).not.toHaveBeenCalled();
  });

  it('shows stacked workflow counts and submit messaging', async () => {
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: {
        name: 'Workers Surface',
        taskCount: 4,
        workflowCount: 2,
        steps: ['Workers Surface Contracts', 'Workers Surface UI'],
        taskGroups: [
          { workflow: 'Workers Surface Contracts', tasks: ['Define contracts', 'Verify contracts'] },
          { workflow: 'Workers Surface UI', tasks: ['Build UI', 'Verify UI'] },
        ],
      },
    })) as any;
    mock.api.planningChatSubmit = vi.fn(async () => ({
      ok: true,
      planName: 'Workers Surface',
      workflowId: 'wf-2',
      workflowIds: ['wf-1', 'wf-2'],
      workflowCount: 2,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the Workers Surface plan');

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('draft ready · "Workers Surface" · 2 workflows · 4 tasks');
    });

    const tasks = screen.getByTestId('invoker-terminal-plan-tasks');
    expect(tasks).toHaveTextContent('Workers Surface Contracts');
    expect(tasks).toHaveTextContent('Define contracts');
    expect(tasks).toHaveTextContent('Verify contracts');
    expect(tasks).toHaveTextContent('Build UI');
    expect(tasks).toHaveTextContent('Verify UI');

    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'session-1' });
      expect(mock.api.refreshTaskGraph).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(
        'Plan "Workers Surface" submitted as 2 stacked workflows. Review them, then use Start ready work.',
      );
      expectSubmittedPlanningSurfaceVisible();
    });
  });

  it('shows submit errors beside the ready draft and allows retry', async () => {
    const submitError = 'Task "make-selected-lists-scroll" uses "autoFix", which is no longer supported.';
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Selected lists scroll', taskCount: 4, steps: ['First', 'Second', 'Third', 'Fourth'] },
    })) as any;
    mock.api.planningChatSubmit = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: submitError })
      .mockResolvedValueOnce({ ok: true, planName: 'Selected lists scroll', workflowId: 'wf-1' }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the full plan');
    await screen.findByTestId('invoker-terminal-ready-bar');

    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));

    const errorPanel = await screen.findByTestId('invoker-terminal-submit-error');
    expect(errorPanel).toHaveTextContent('Plan could not be submitted');
    expect(errorPanel).toHaveTextContent(submitError);
    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(`Plan could not be submitted: ${submitError}`);
    expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('draft ready · "Selected lists scroll" · 4 tasks');
    expect(mock.api.refreshTaskGraph).not.toHaveBeenCalled();

    fireEvent.click(within(errorPanel).getByRole('button', { name: 'Retry submit' }));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledTimes(2);
      expect(mock.api.refreshTaskGraph).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Plan "Selected lists scroll" submitted to Invoker. Review it, then use Start ready work.');
      expectSubmittedPlanningSurfaceVisible();
      expect(screen.queryByTestId('invoker-terminal-submit-error')).not.toBeInTheDocument();
    });
  });

  it('surfaces a planner failure on the first message even before a draft exists', async () => {
    // Regression: the "Planner could not respond" error card used to be nested
    // inside the draft-ready branch, so a first-message failure (the common
    // case) hid the raw error message behind only a red transcript line. The
    // card must now render as soon as the send fails, even when no draft plan
    // exists yet, so users see the full stderr tail and the Copy error button.
    const plannerError = 'agent exited 0 but produced no output after 3 attempts — stderr tail: cursor: session expired; run `cursor login` to re-authenticate';
    mock.api.planningChatSend = vi.fn(async () => ({ ok: false, sessionId: 'session-1', error: plannerError })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('Draft me an Invoker plan');

    const errorPanel = await screen.findByTestId('invoker-terminal-submit-error');
    expect(errorPanel).toHaveTextContent('Planner could not respond');
    expect(errorPanel).toHaveTextContent(plannerError);
    expect(within(errorPanel).getByRole('button', { name: 'Keep chatting' })).toBeInTheDocument();
    expect(within(errorPanel).getByRole('button', { name: 'Copy error' })).toBeInTheDocument();
    expect(within(errorPanel).queryByRole('button', { name: 'Retry submit' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
  });

  it('explains that run needs a submitted plan first', async () => {
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('run');

    expect(await screen.findByText('Create or submit a plan before starting ready work.')).toBeInTheDocument();
    expect(mock.api.startReady).not.toHaveBeenCalled();
    expect(mock.api.start).not.toHaveBeenCalled();
  });

  it('marks a submitted planning session read-only', async () => {
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First', 'Second'] },
    })) as any;
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the full plan');
    await screen.findByTestId('invoker-terminal-ready-bar');
    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));
    await waitFor(() => expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'session-1' }));
    await waitFor(() => expectSubmittedPlanningSurfaceVisible());

    const input = screen.getByTestId('invoker-terminal-input');
    expect(input).toBeDisabled();
    expect(input).toHaveClass('disabled:cursor-not-allowed');
    expect(input).not.toHaveClass('disabled:cursor-wait');
    expect(screen.getAllByText(/submitted/i).length).toBeGreaterThan(0);
  });

  it('opens the expanded planning chat and Escape closes it without clearing transcript', async () => {
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('hello');
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('I can help draft that.'));

    fireEvent.click(screen.getByRole('button', { name: 'Expand planning chat' }));
    expect(screen.getByTestId('invoker-terminal-expanded')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-expanded')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('I can help draft that.');
  });

  it('creates another planning chat without clearing the first transcript', async () => {
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('hello');
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('I can help draft that.'));

    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    expect(screen.getByTestId('invoker-terminal-input')).toHaveValue('');
    expect(screen.getByTestId('invoker-terminal-transcript')).not.toHaveTextContent('I can help draft that.');

    fireEvent.click(screen.getByText('hello'));

    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('I can help draft that.');
  });

  it('wraps long planning session rail titles and previews instead of clipping them to one line', async () => {
    const longPrompt = 'Draft a very long planning session title that needs multiple readable wrapped lines in the fixed planning rail';
    const longReply = [
      'This planning preview should remain readable in the rail with several wrapped words,',
      'including implementation details, verification notes, and follow-up context that used to be hidden by truncate.',
    ].join(' ');
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: longReply,
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText(longPrompt);

    const rail = screen.getByTestId('planning-session-list');
    await waitFor(() => {
      expect(within(rail).getByText(longReply)).toBeInTheDocument();
    });

    const expectedTitle = `${longPrompt.slice(0, 53).trimEnd()}…`;
    const title = within(rail).getByText(expectedTitle);
    const preview = within(rail).getByText(longReply);
    expect(title).toHaveClass('line-clamp-2', 'min-w-0', 'flex-1', 'break-words', 'leading-5');
    expect(title).not.toHaveClass('truncate');
    expect(title).toHaveAttribute('title', expectedTitle);
    expect(preview).toHaveClass('mt-1', 'line-clamp-3', 'break-words');
    expect(preview).not.toHaveClass('truncate');
    expect(preview).toHaveAttribute('title', longReply);
    expect(screen.getByTestId('planning-session-rail')).toHaveClass('w-64', 'shrink-0');
  });

  it('keeps a new planning chat editable while another session is working', async () => {
    let resolveFirstSend: ((value: any) => void) | null = null;
    mock.api.planningChatSend = vi.fn((request: any) => {
      if (!request.sessionId) {
        return new Promise((resolve) => {
          resolveFirstSend = resolve;
        }) as any;
      }
      return Promise.resolve({
        ok: true,
        sessionId: request.sessionId,
        reply: 'Second session is ready.',
        draftPlanAvailable: false,
      }) as any;
    }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first session request');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    const secondInput = screen.getByTestId('invoker-terminal-input');
    expect(secondInput).not.toBeDisabled();
    fireEvent.change(secondInput, { target: { value: 'second session request' } });
    expect(secondInput).toHaveValue('second session request');

    resolveFirstSend?.({
      ok: true,
      sessionId: 'session-1',
      reply: 'First session is ready.',
      draftPlanAvailable: false,
    });
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-input')).toHaveValue('second session request'));
  });

  it('auto-follows a new assistant reply when the transcript is near the bottom', async () => {
    const props = terminalProps();
    const { rerender } = render(<InvokerTerminal {...props} />);
    const transcript = screen.getByTestId('invoker-terminal-transcript');
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 400 });

    transcript.scrollTop = 268;
    fireEvent.scroll(transcript);
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 500 });
    rerender(<InvokerTerminal {...props} lines={[...props.lines, { id: 2, text: 'Second line', role: 'assistant' as const }]} />);

    await waitFor(() => expect(transcript.scrollTop).toBe(500));
  });

  it('does not force-scroll after the user scrolls away from the bottom', async () => {
    const props = terminalProps({
      lines: [
        { id: 1, text: 'First line', role: 'system' as const },
        { id: 2, text: 'Second line', role: 'assistant' as const },
      ],
    });
    const { rerender } = render(<InvokerTerminal {...props} />);
    const transcript = screen.getByTestId('invoker-terminal-transcript');
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 500 });

    transcript.scrollTop = 50;
    fireEvent.scroll(transcript);
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 600 });
    rerender(<InvokerTerminal {...props} lines={[
      ...props.lines,
      { id: 3, text: 'Third line', role: 'assistant' as const },
    ]} />);

    await waitFor(() => expect(screen.getByText('Third line')).toBeInTheDocument());
    expect(transcript.scrollTop).toBe(50);
  });

  it('resets transcript follow mode when the active planning conversation changes', async () => {
    const props = terminalProps({
      lines: [{ id: 1, text: 'First chat', role: 'system' as const }],
    });
    const { rerender } = render(<InvokerTerminal {...props} />);
    const transcript = screen.getByTestId('invoker-terminal-transcript');
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 400 });

    transcript.scrollTop = 50;
    fireEvent.scroll(transcript);
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 500 });
    const nextProps = terminalProps({
      activeConversationKey: 'chat-2',
      lines: [{ id: 2, text: 'Second chat', role: 'system' as const }],
    });
    rerender(<InvokerTerminal {...nextProps} />);

    await waitFor(() => expect(transcript.scrollTop).toBe(500));

    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 600 });
    rerender(<InvokerTerminal
      {...nextProps}
      lines={[...nextProps.lines, { id: 3, text: 'Second chat reply', role: 'assistant' as const }]}
    />);

    await waitFor(() => expect(transcript.scrollTop).toBe(600));
  });

  it('constrains left rail lists to bounded scroll regions', async () => {
    const workflows: WorkflowMeta[] = [
      { id: 'wf-alpha', name: 'Alpha', status: 'running' },
      { id: 'wf-beta', name: 'Beta', status: 'failed' },
    ];
    const tasks = [
      makeUITask({
        id: 'wf-alpha/running-task',
        description: 'Running rail task',
        status: 'running',
        workflowId: 'wf-alpha',
        command: 'echo running',
      }),
      makeUITask({
        id: 'wf-beta/attention-task',
        description: 'Attention rail task',
        status: 'failed',
        workflowId: 'wf-beta',
        command: 'echo failed',
      }),
    ];

    mock.cleanup();
    mock = createMockInvoker(tasks, workflows);
    mock.install();
    render(<App />);

    await expectSurfaceRailList('planning', 'planning-session-list');
    await expectSurfaceRailList('workflows', 'workflows-rail-list');
    await expectSurfaceRailList('attention', 'attention-rail-list');
    expect(screen.queryByTestId('running-rail-list')).not.toBeInTheDocument();
  });
});
