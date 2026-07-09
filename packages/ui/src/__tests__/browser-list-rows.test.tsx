import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserTaskRow, BrowserWorkflowRow } from '../components/BrowserListRows.js';

describe('BrowserTaskRow', () => {
  it('renders the title and status·workflow line and reports the task id on click', () => {
    const onSelect = vi.fn();
    render(
      <BrowserTaskRow
        taskId="wf-1/build"
        title="Build the thing"
        workflowName="wf-1"
        statusLabel="awaiting review"
        tone="attention"
        selected={false}
        onSelect={onSelect}
      />,
    );
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('Build the thing');
    expect(button).toHaveTextContent('awaiting review · wf-1');

    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('wf-1/build');
  });

  it('omits the workflow suffix when no workflow name is provided', () => {
    render(
      <BrowserTaskRow taskId="t1" title="t" statusLabel="running" tone="running" selected={false} onSelect={() => {}} />,
    );
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('running');
    expect(button.textContent).not.toContain('·');
  });

  it('applies the tone-specific selected accent only when selected', () => {
    const { rerender } = render(
      <BrowserTaskRow taskId="t1" title="t" statusLabel="s" tone="attention" selected={false} onSelect={() => {}} />,
    );
    expect(screen.getByRole('button').className).not.toContain('ring-amber-500/40');

    rerender(
      <BrowserTaskRow taskId="t1" title="t" statusLabel="s" tone="attention" selected={true} onSelect={() => {}} />,
    );
    expect(screen.getByRole('button').className).toContain('ring-amber-500/40');
  });

  it('is a memo component so unchanged rows bail out of re-render', () => {
    expect((BrowserTaskRow as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });
});

describe('BrowserWorkflowRow', () => {
  it('appends a pluralized task count and reports the workflow id on click', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <BrowserWorkflowRow workflowId="wf-1" name="My workflow" taskCount={1} statusLabel="running" selected={false} onSelect={onSelect} />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('running · 1 task');

    rerender(
      <BrowserWorkflowRow workflowId="wf-1" name="My workflow" taskCount={3} statusLabel="running" selected={false} onSelect={onSelect} />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('running · 3 tasks');

    fireEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith('wf-1');
  });

  it('omits the task-count suffix when there are no tasks', () => {
    render(
      <BrowserWorkflowRow workflowId="wf-1" name="Empty" taskCount={0} statusLabel="pending" selected={false} onSelect={() => {}} />,
    );
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('pending');
    expect(button.textContent).not.toContain('·');
  });

  it('is a memo component so unchanged rows bail out of re-render', () => {
    expect((BrowserWorkflowRow as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });
});
