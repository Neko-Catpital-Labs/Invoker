import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Dynamic imports are required so modules see the hoisted @xyflow/react mock.
const { App } = await import('../App.js');
const { InvokerTerminal } = await import('../components/InvokerTerminal.js');

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

  async function expectSurfaceRailList(surface: 'planning' | 'workflows' | 'attention' | 'running', listTestId: string) {
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
      expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('draft ready · "Mock Plan" · 2 steps');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'session-1' });
      expect(mock.api.refreshTaskGraph).toHaveBeenCalled();
      expect(screen.getByText('Plan graph')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('sidebar-planning'));
    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Plan "Mock Plan" submitted to Invoker. Review it, then Run.');
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
      expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('draft ready · "Workers Surface" · 2 workflows');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'session-1' });
      expect(mock.api.refreshTaskGraph).toHaveBeenCalled();
      expect(screen.getByText('Plan graph')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('sidebar-planning'));
    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(
      'Plan "Workers Surface" submitted as 2 stacked workflows. Review them, then Run.',
    );
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
    expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('draft ready · "Selected lists scroll" · 4 steps');
    expect(mock.api.refreshTaskGraph).not.toHaveBeenCalled();

    fireEvent.click(within(errorPanel).getByRole('button', { name: 'Retry submit' }));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledTimes(2);
      expect(mock.api.refreshTaskGraph).toHaveBeenCalled();
      expect(screen.getByText('Plan graph')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('sidebar-planning'));
    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Plan "Selected lists scroll" submitted to Invoker. Review it, then Run.');
    expect(screen.queryByTestId('invoker-terminal-submit-error')).not.toBeInTheDocument();
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

    expect(await screen.findByText('Create or submit a plan before running.')).toBeInTheDocument();
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

    fireEvent.click(screen.getByTestId('sidebar-planning'));

    expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled();
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

  it('follows new transcript lines until the user scrolls away from the bottom', async () => {
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
    const transcript = screen.getByTestId('invoker-terminal-transcript');
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 400 });

    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 500 });
    rerender(<InvokerTerminal {...props} lines={[...props.lines, { id: 2, text: 'Second line', role: 'assistant' as const }]} />);

    await waitFor(() => expect(transcript.scrollTop).toBe(500));

    transcript.scrollTop = 50;
    fireEvent.scroll(transcript);
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 600 });
    rerender(<InvokerTerminal {...props} lines={[
      ...props.lines,
      { id: 2, text: 'Second line', role: 'assistant' as const },
      { id: 3, text: 'Third line', role: 'assistant' as const },
    ]} />);

    expect(transcript.scrollTop).toBe(50);

    transcript.scrollTop = 500;
    fireEvent.scroll(transcript);
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 700 });
    rerender(<InvokerTerminal {...props} lines={[
      ...props.lines,
      { id: 2, text: 'Second line', role: 'assistant' as const },
      { id: 3, text: 'Third line', role: 'assistant' as const },
      { id: 4, text: 'Fourth line', role: 'assistant' as const },
    ]} />);

    await waitFor(() => expect(transcript.scrollTop).toBe(700));
  });

  it('resets transcript follow mode when the active planning conversation changes', async () => {
    const props = {
      activeConversationKey: 'chat-1',
      lines: [{ id: 1, text: 'First chat', role: 'system' as const }],
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
    const transcript = screen.getByTestId('invoker-terminal-transcript');
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 400 });

    transcript.scrollTop = 50;
    fireEvent.scroll(transcript);
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 500 });
    rerender(<InvokerTerminal
      {...props}
      activeConversationKey="chat-2"
      lines={[{ id: 2, text: 'Second chat', role: 'system' as const }]}
    />);

    await waitFor(() => expect(transcript.scrollTop).toBe(500));
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
    await expectSurfaceRailList('running', 'running-rail-list');
  });
});
