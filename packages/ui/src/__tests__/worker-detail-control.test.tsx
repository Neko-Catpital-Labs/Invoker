import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkerDetailControl } from '../components/WorkerDetailControl.js';
import type { WorkerStatusEntry } from '../types.js';

function makeWorker(overrides: Partial<WorkerStatusEntry> = {}): WorkerStatusEntry {
  return {
    kind: 'pr-status',
    note: 'Polls review-gate PR status.',
    lifecycle: 'running',
    policy: 'enabled',
    autoStarts: true,
    desiredEnabled: true,
    startable: false,
    stoppable: true,
    recentActions: [],
    ...overrides,
  };
}

describe('WorkerDetailControl', () => {
  it('stops the selected worker and names it in the call', async () => {
    const onStopWorker = vi.fn(async () => {});
    render(
      <WorkerDetailControl
        worker={makeWorker()}
        onStartWorker={vi.fn()}
        onStopWorker={onStopWorker}
      />,
    );

    const control = screen.getByTestId('worker-detail-start-stop');
    expect(control).toHaveTextContent('Disable worker');
    expect(control).toHaveAttribute('data-action', 'stop');

    fireEvent.click(control);

    await waitFor(() => expect(onStopWorker).toHaveBeenCalledWith('pr-status'));
  });

  it('starts a stopped worker', async () => {
    const onStartWorker = vi.fn(async () => {});
    render(
      <WorkerDetailControl
        worker={makeWorker({ kind: 'autofix', lifecycle: 'stopped', startable: true, stoppable: false })}
        onStartWorker={onStartWorker}
        onStopWorker={vi.fn()}
      />,
    );

    const control = screen.getByTestId('worker-detail-start-stop');
    expect(control).toHaveTextContent('Enable worker');

    fireEvent.click(control);

    await waitFor(() => expect(onStartWorker).toHaveBeenCalledWith('autofix'));
  });

  it('offers to start an exited worker rather than stop it', () => {
    render(
      <WorkerDetailControl
        worker={makeWorker({ lifecycle: 'exited' })}
        onStartWorker={vi.fn()}
        onStopWorker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('worker-detail-start-stop')).toHaveAttribute('data-action', 'start');
  });

  it('is disabled in a read-only window', () => {
    const onStopWorker = vi.fn();
    render(
      <WorkerDetailControl
        worker={makeWorker()}
        readOnly
        onStartWorker={vi.fn()}
        onStopWorker={onStopWorker}
      />,
    );

    const control = screen.getByTestId('worker-detail-start-stop');
    expect(control).toBeDisabled();
    expect(control).toHaveAttribute('title', 'Read-only window');
    fireEvent.click(control);
    expect(onStopWorker).not.toHaveBeenCalled();
  });

  it('honours a host-supplied reason for disabling the control', () => {
    render(
      <WorkerDetailControl
        worker={makeWorker({ controlDisabledReason: 'Controls unavailable' })}
        onStartWorker={vi.fn()}
        onStopWorker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('worker-detail-start-stop')).toBeDisabled();
  });

  it('snaps back and logs when the host rejects the change', async () => {
    const error = new Error('Worker runtime controller is unavailable');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <WorkerDetailControl
        worker={makeWorker()}
        onStartWorker={vi.fn()}
        onStopWorker={vi.fn(async () => { throw error; })}
      />,
    );

    const control = screen.getByTestId('worker-detail-start-stop');
    fireEvent.click(control);

    await waitFor(() => expect(control).toHaveAttribute('data-action', 'stop'));
    expect(control).toHaveTextContent('Disable worker');
    expect(consoleError).toHaveBeenCalledWith('Failed to disable worker pr-status', error);
    consoleError.mockRestore();
  });

  it('drops optimistic state when the panel switches to another worker', async () => {
    const { rerender } = render(
      <WorkerDetailControl
        worker={makeWorker()}
        onStartWorker={vi.fn()}
        onStopWorker={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(screen.getByTestId('worker-detail-start-stop'));
    await waitFor(() => expect(screen.getByTestId('worker-detail-start-stop')).toHaveAttribute('data-action', 'start'));

    rerender(
      <WorkerDetailControl
        worker={makeWorker({ kind: 'ci-failure', lifecycle: 'running' })}
        onStartWorker={vi.fn()}
        onStopWorker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('worker-detail-start-stop')).toHaveAttribute('data-action', 'stop');
  });
});
