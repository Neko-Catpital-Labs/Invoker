import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkflowStatusChips } from '../components/WorkflowStatusChips.js';
import type { WorkflowMeta } from '../types.js';

describe('WorkflowStatusChips queue capacity', () => {
  it('shows executing and queued counts from queue chrome on the home bottom chrome', () => {
    const workflows = new Map<string, WorkflowMeta>([
      ['wf-1', { id: 'wf-1', name: 'One', status: 'running' }],
    ]);
    const queueChrome = {
      maxConcurrency: 8,
      runningCount: 3,
      activeExecutionCount: 1,
      launchingCount: 2,
      queuedCount: 2,
    };
    const onOpenRunningSurface = vi.fn();

    render(
      <WorkflowStatusChips
        workflows={workflows}
        activeFilters={new Set()}
        onStatusClick={() => {}}
        queueChrome={queueChrome}
        onOpenRunningSurface={onOpenRunningSurface}
      />,
    );

    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (1/8)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (3/8)');
    expect(screen.getByTestId('queue-chip-launching')).toHaveTextContent('Launching (2)');
    expect(screen.getByTestId('queue-chip-queued')).toHaveTextContent('Queued (2)');
    expect(screen.getByTestId('workflow-status-pill-running')).toHaveTextContent('workflows running (1)');

    fireEvent.click(screen.getByTestId('queue-chip-queued'));
    expect(onOpenRunningSurface).toHaveBeenCalledTimes(1);
  });
});
