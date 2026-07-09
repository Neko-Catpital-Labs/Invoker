import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
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
      expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('Draft plan ready: "Mock Plan" (2 steps).');
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
      expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('Draft plan ready: "Workers Surface" (2 workflows).');
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
    expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('Draft plan ready: "Selected lists scroll" (4 steps).');
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
    expect(screen.getAllByText('Submitted').length).toBeGreaterThan(0);
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

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

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

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

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
});

describe('Left rail scroll containers (layout)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  // Regression: rail list bodies used to be plain blocks (`overflow-y-auto p-3`)
  // that grew their parent panel with content instead of scrolling. The contract
  // is now: the scroll container is a shrinkable flex child
  // (`min-h-0 flex-1 overflow-y-auto`) nested inside a bounded flex-col shell body
  // (`flex min-h-0 flex-1 flex-col`), so overflow scrolls in place within the rail.
  function expectScrollableRailList(rail: HTMLElement) {
    const listBody = rail.querySelector('.overflow-y-auto');
    expect(listBody, 'rail should own a single scroll container').not.toBeNull();
    const bodyClass = listBody!.className;
    expect(bodyClass).toContain('min-h-0');
    expect(bodyClass).toContain('flex-1');

    const shellBody = listBody!.parentElement!;
    const shellClass = shellBody.className;
    expect(shellClass).toContain('flex');
    expect(shellClass).toContain('flex-col');
    expect(shellClass).toContain('min-h-0');
    expect(shellClass).toContain('flex-1');
  }

  it('keeps the planning session list scrollable inside the rail', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    const rail = await screen.findByTestId('planning-session-rail');
    expectScrollableRailList(rail);
  });

  // The `browser-rail` list wrapper is the SAME element for the workflows,
  // attention, and running surfaces (only the inner list function differs), and
  // all three list bodies share RAIL_LIST_BODY_CLASS. Asserting the workflows
  // surface therefore also proves the shell-wrapper + list-body contract the
  // attention and running lists reuse. Those two surfaces cannot be mounted
  // directly here: selecting a live task auto-mounts the xterm terminal, which
  // hangs under jsdom's canvas-less renderer — the same pre-existing harness
  // limitation documented in browser-surface-camera-resnap.test.tsx, which also
  // drives the shared browser-surface mechanism through the Workflows surface.
  it('keeps the workflows list scrollable inside the shared browser rail', async () => {
    render(<App />);
    act(() => mock.setTasks(
      [makeUITask({ id: 'task-wf', description: 'WF task', status: 'running', workflowId: 'wf-1' })],
      [{ id: 'wf-1', name: 'Alpha', status: 'running' }] satisfies WorkflowMeta[],
    ));
    fireEvent.click(await screen.findByTestId('sidebar-workflows'));
    const rail = await screen.findByTestId('browser-rail');
    await within(rail).findByText('Alpha');
    expectScrollableRailList(rail);
  });
});
