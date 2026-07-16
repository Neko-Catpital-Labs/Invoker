import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkerActivityCard } from '../components/WorkerActivityCard.js';
import type { WorkerStatusEntry, WorkerStatusSnapshot } from '../types.js';

function makeWorker(overrides: Partial<WorkerStatusEntry> = {}): WorkerStatusEntry {
  return {
    kind: 'ci-failure',
    note: 'Repairs failed CI.',
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

function makeSnapshot(overrides: Partial<WorkerStatusSnapshot> = {}): WorkerStatusSnapshot {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    globalEnabled: true,
    workers: [makeWorker()],
    ...overrides,
  };
}

describe('worker global switch', () => {
  it('turns workers off and reports the new state to the caller', async () => {
    const onSetWorkersEnabled = vi.fn(async () => {});
    render(
      <WorkerActivityCard
        snapshot={makeSnapshot()}
        selectedWorkerKind={null}
        onSelectWorker={vi.fn()}
        onSetWorkersEnabled={onSetWorkersEnabled}
      />,
    );

    const toggle = screen.getByTestId('worker-global-switch');
    expect(toggle).toHaveTextContent('Turn workers off');
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);

    await waitFor(() => expect(onSetWorkersEnabled).toHaveBeenCalledWith(false));
  });

  it('turns workers back on when the switch is off', async () => {
    const onSetWorkersEnabled = vi.fn(async () => {});
    render(
      <WorkerActivityCard
        snapshot={makeSnapshot({ globalEnabled: false, workers: [makeWorker({ lifecycle: 'stopped' })] })}
        selectedWorkerKind={null}
        onSelectWorker={vi.fn()}
        onSetWorkersEnabled={onSetWorkersEnabled}
      />,
    );

    const toggle = screen.getByTestId('worker-global-switch');
    expect(toggle).toHaveTextContent('Turn workers on');
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    await waitFor(() => expect(onSetWorkersEnabled).toHaveBeenCalledWith(true));
  });

  it('disables the per-worker control while the switch is off', () => {
    render(
      <WorkerActivityCard
        snapshot={makeSnapshot({ globalEnabled: false, workers: [makeWorker({ lifecycle: 'stopped' })] })}
        selectedWorkerKind={null}
        onSelectWorker={vi.fn()}
        onStartWorker={vi.fn()}
        onStopWorker={vi.fn()}
        onSetWorkersEnabled={vi.fn()}
      />,
    );

    const control = screen.getByTestId('worker-start-stop-ci-failure');
    expect(control).toBeDisabled();
    expect(control).toHaveAttribute('title', 'Workers are turned off');
  });

  it('treats a snapshot with no global flag as on, so older hosts keep working', () => {
    const snapshot = makeSnapshot();
    delete snapshot.globalEnabled;
    render(
      <WorkerActivityCard
        snapshot={snapshot}
        selectedWorkerKind={null}
        onSelectWorker={vi.fn()}
        onSetWorkersEnabled={vi.fn()}
      />,
    );

    expect(screen.getByTestId('worker-global-switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('hides the switch on read-only surfaces that render without controls', () => {
    render(
      <WorkerActivityCard
        snapshot={makeSnapshot()}
        selectedWorkerKind={null}
        onSelectWorker={vi.fn()}
        showControls={false}
      />,
    );

    expect(screen.queryByTestId('worker-global-switch')).toBeNull();
  });
});
