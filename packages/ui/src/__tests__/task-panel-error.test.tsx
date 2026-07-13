import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TaskPanel } from '../components/TaskPanel.js';
import type { TaskState } from '../types.js';

function makeTask(
  overrides: Partial<TaskState> & {
    command?: string;
    prompt?: string;
  } = {},
): TaskState {
  const { command, prompt, ...rest } = overrides;
  return {
    id: 'error-test',
    description: 'Test task',
    status: 'failed',
    dependencies: [],
    createdAt: new Date(),
    config: { command, prompt },
    execution: {},
    ...rest,
  } as TaskState;
}

const noop = vi.fn();

describe('TaskPanel error display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { invoker?: unknown }).invoker;
  });

  function mockAuditEvents(events: Array<{ eventType: string; payload?: string }>) {
    const getEvents = vi.fn(async () => events);
    (window as unknown as { invoker: { getEvents: typeof getEvents } }).invoker = { getEvents };
    return getEvents;
  }

  it('shows error message and exit code when both present', () => {
    const task = makeTask({
      execution: { error: 'SSH key not found', exitCode: 1 },
    });
    render(
      <TaskPanel
        task={task}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Error' }),
    ).toBeInTheDocument();
    expect(screen.getByText('SSH key not found')).toBeInTheDocument();
    expect(screen.getByText('Exit code: 1')).toBeInTheDocument();
  });

  it('shows only exit code when error is undefined', () => {
    const task = makeTask({
      execution: { exitCode: 1 },
    });
    render(
      <TaskPanel
        task={task}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );
    expect(screen.getByText('Exit code: 1')).toBeInTheDocument();
    expect(
      screen.queryByText('SSH key not found'),
    ).not.toBeInTheDocument();
  });

  it('shows multiline error with stack trace', () => {
    const errorMsg =
      'Executor startup failed (ssh): bad key\n    at SshExecutor.start (ssh-executor.ts:42)';
    const task = makeTask({
      execution: { error: errorMsg, exitCode: 1 },
    });
    render(
      <TaskPanel
        task={task}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );
    expect(screen.getByText((_content, element) => {
      return element?.textContent === errorMsg;
    })).toBeInTheDocument();
  });

  it('does not show error panel for successful task', () => {
    const task = makeTask({
      status: 'completed',
      execution: { exitCode: 0 },
    });
    render(
      <TaskPanel
        task={task}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );
    expect(
      screen.queryByRole('heading', { name: 'Error' }),
    ).not.toBeInTheDocument();
  });

  it('does not show error panel when exitCode is undefined', () => {
    const task = makeTask({ status: 'pending', execution: {} });
    render(
      <TaskPanel
        task={task}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );
    expect(
      screen.queryByRole('heading', { name: 'Error' }),
    ).not.toBeInTheDocument();
  });

  it('shows current no-workspace error and earlier provisioning failure from audit events', async () => {
    const setupError = 'Worktree provisioning failed\npnpm install failed before workspace metadata was saved';
    const getEvents = mockAuditEvents([
      {
        eventType: 'task.failed',
        payload: JSON.stringify({ execution: { error: setupError } }),
      },
    ]);
    const task = makeTask({
      execution: { error: 'no valid workspace for failed task', exitCode: 1 },
    });

    render(
      <TaskPanel
        task={task}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );

    const errorHeading = screen.getByRole('heading', { name: 'Error' });
    expect(screen.getByText('no valid workspace for failed task')).toBeInTheDocument();
    expect(await screen.findByText((_content, element) => element?.tagName === 'PRE' && element.textContent === setupError)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Workspace Setup Failure' })).not.toBeInTheDocument();
    expect(errorHeading.closest('div')).toHaveTextContent('no valid workspace for failed task');
    expect(errorHeading.closest('div')).toHaveTextContent('Worktree provisioning failed');
    expect(getEvents).toHaveBeenCalledWith(task.id, { limit: 50, sortBy: 'desc' });
  });

  it('renders ERR_PNPM_UNSUPPORTED_ENGINE audit error exactly', async () => {
    const setupError = [
      'Executor startup failed (worktree)',
      'ERR_PNPM_UNSUPPORTED_ENGINE Unsupported environment (bad pnpm and/or Node.js version)',
      'Expected version: >=20',
    ].join('\n');
    mockAuditEvents([
      {
        eventType: 'task.failed',
        payload: JSON.stringify({ execution: { error: setupError } }),
      },
    ]);

    render(
      <TaskPanel
        task={makeTask({ execution: { error: 'Task failed after launch retry' } })}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );

    expect(await screen.findByText((_content, element) => element?.tagName === 'PRE' && element.textContent === setupError)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Workspace Setup Failure' })).not.toBeInTheDocument();
  });

  it('does not duplicate audit setup error already present in current task error', async () => {
    const setupError = 'Executor startup failed (ssh): permission denied';
    mockAuditEvents([
      {
        eventType: 'task.failed',
        payload: JSON.stringify({ execution: { error: setupError } }),
      },
    ]);

    render(
      <TaskPanel
        task={makeTask({ execution: { error: `Latest failure:\n${setupError}`, exitCode: 1 } })}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(setupError)).not.toBeInTheDocument();
    });
  });

  it('ignores malformed audit payload without crashing', async () => {
    mockAuditEvents([
      { eventType: 'task.failed', payload: '{not json' },
      {
        eventType: 'task.failed',
        payload: JSON.stringify({ execution: { error: 123 } }),
      },
    ]);

    render(
      <TaskPanel
        task={makeTask({ execution: { error: 'regular failure' } })}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Error' })).toBeInTheDocument();
      expect(screen.queryByText('Workspace Setup Failure')).not.toBeInTheDocument();
    });
    expect(screen.getByText('regular failure')).toBeInTheDocument();
  });

  it('does not show workspace setup section when audit failures do not match setup markers', async () => {
    mockAuditEvents([
      {
        eventType: 'task.failed',
        payload: JSON.stringify({ execution: { error: 'Unit tests failed' } }),
      },
      {
        eventType: 'task.completed',
        payload: JSON.stringify({ execution: { error: 'Executor startup failed but completed event' } }),
      },
    ]);

    render(
      <TaskPanel
        task={makeTask({ execution: { error: 'Unit tests failed' } })}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Workspace Setup Failure')).not.toBeInTheDocument();
    });
  });
});
