import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Dynamic import is required so App sees the hoisted @xyflow/react mock.
const { App } = await import('../App.js');

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
});
