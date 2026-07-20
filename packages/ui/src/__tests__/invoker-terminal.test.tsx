import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { InvokerTerminal } from '../components/InvokerTerminal.js';

function terminalProps(overrides: Partial<Parameters<typeof InvokerTerminal>[0]> = {}) {
  return {
    activeConversationKey: 'planning-chat-1',
    lines: [],
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

describe('InvokerTerminal planning copy', () => {
  it('uses neutral planning copy before a draft exists', () => {
    render(<InvokerTerminal {...terminalProps()} />);

    expect(screen.getByRole('heading', { name: 'Planning chat' })).toBeInTheDocument();
    expect(screen.getByText('Still discussing')).toBeInTheDocument();
    expect(screen.getByTestId('invoker-terminal-empty-hero')).toHaveTextContent('What do you want to build?');
    expect(screen.getByTestId('invoker-terminal-empty-hero')).toHaveTextContent('help scope the plan');
    expect(screen.getByTestId('invoker-terminal-input')).toHaveAttribute('placeholder', 'Describe the change or ask a planning question.');
    expect(screen.queryByText('Drafting your plan...')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
  });

  it('shows planning stream status without reverting to drafting copy', () => {
    render(
      <InvokerTerminal
        {...terminalProps({
          busy: true,
          planningStream: { status: 'streaming', text: 'checking constraints' },
        })}
      />,
    );

    expect(screen.getByText('Planning your next steps...')).toBeInTheDocument();
    const stream = screen.getByTestId('invoker-terminal-planner-stream');
    expect(stream).toHaveAttribute('data-state', 'streaming');
    expect(stream).toHaveTextContent('Planner stream');
    expect(stream).toHaveTextContent('live');
    expect(stream).toHaveTextContent('checking constraints');
    expect(screen.queryByText('Drafting your plan...')).not.toBeInTheDocument();
    expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled();
  });

  it('keeps draft-ready controls and copy when a real draft exists', () => {
    const onSubmitDraft = vi.fn();
    const onOpenGraph = vi.fn();
    render(
      <InvokerTerminal
        {...terminalProps({
          draftPlanAvailable: true,
          draftPlanSummary: {
            name: 'Mock Plan',
            taskCount: 2,
            taskGroups: [{ workflow: 'Mock Workflow', tasks: ['First task', 'Second task'] }],
          },
          onSubmitDraft,
          onOpenGraph,
        })}
      />,
    );

    const readyBar = screen.getByTestId('invoker-terminal-ready-bar');
    expect(readyBar).toHaveTextContent('Plan draft ready');
    expect(readyBar).toHaveTextContent('draft ready · "Mock Plan" · 2 tasks');
    expect(screen.getByTestId('invoker-terminal-plan-tasks')).toHaveTextContent('Mock Workflow');
    expect(screen.getByTestId('invoker-terminal-plan-tasks')).toHaveTextContent('Second task');

    fireEvent.click(within(readyBar).getByRole('button', { name: 'Submit to Invoker' }));
    expect(onSubmitDraft).toHaveBeenCalledTimes(1);

    fireEvent.click(within(readyBar).getByRole('button', { name: 'Open graph' }));
    expect(onOpenGraph).toHaveBeenCalledTimes(1);
  });

  it('keeps submit errors beside the ready draft and allows retry', () => {
    const onSubmitDraft = vi.fn();
    render(
      <InvokerTerminal
        {...terminalProps({
          draftPlanAvailable: true,
          draftPlanSummary: { name: 'Retry Plan', taskCount: 1 },
          submitError: {
            title: 'Plan could not be submitted',
            message: 'Invalid task id.',
          },
          onSubmitDraft,
        })}
      />,
    );

    const errorPanel = screen.getByTestId('invoker-terminal-submit-error');
    expect(errorPanel).toHaveTextContent('Plan could not be submitted');
    expect(errorPanel).toHaveTextContent('Invalid task id.');
    expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('draft ready · "Retry Plan" · 1 task');

    fireEvent.click(within(errorPanel).getByRole('button', { name: 'Retry submit' }));
    expect(onSubmitDraft).toHaveBeenCalledTimes(1);
  });

  it('marks submitted planning sessions read-only without changing submitted copy', () => {
    const onOpenGraph = vi.fn();
    render(
      <InvokerTerminal
        {...terminalProps({
          readOnly: true,
          submittedPlanName: 'Mock Plan',
          onOpenGraph,
        })}
      />,
    );

    expect(screen.getByText('submitted')).toBeInTheDocument();
    const submittedBar = screen.getByTestId('invoker-terminal-submitted-bar');
    expect(submittedBar).toHaveTextContent('Plan ready · "Mock Plan" · review the graph, then Start ready work');
    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit to Invoker' })).not.toBeInTheDocument();

    const input = screen.getByTestId('invoker-terminal-input');
    expect(input).toBeDisabled();
    expect(input).toHaveClass('disabled:cursor-not-allowed');
    expect(input).not.toHaveClass('disabled:cursor-wait');

    fireEvent.click(within(submittedBar).getByRole('button', { name: 'Open graph' }));
    expect(onOpenGraph).toHaveBeenCalledTimes(1);
  });
});
