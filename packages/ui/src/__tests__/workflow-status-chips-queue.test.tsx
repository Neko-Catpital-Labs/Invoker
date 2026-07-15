import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkflowStatusChips } from '../components/WorkflowStatusChips.js';
import type { QueueStatus, WorkflowMeta } from '../types.js';

describe('WorkflowStatusChips queue capacity', () => {
  it('shows executing and queued counts from queue status on the home bottom chrome', () => {
    const workflows = new Map<string, WorkflowMeta>([
      ['wf-1', { id: 'wf-1', name: 'One', status: 'running' }],
    ]);
    const queueStatus: QueueStatus = {
      maxConcurrency: 8,
      runningCount: 3,
      running: [
        { taskId: 'a', description: 'a' },
        { taskId: 'b', description: 'b' },
        { taskId: 'c', description: 'c' },
      ],
      queued: [
        { taskId: 'd', priority: 0, description: 'd' },
        { taskId: 'e', priority: 0, description: 'e' },
      ],
    };
    const onOpenRunningSurface = vi.fn();

    render(
      <WorkflowStatusChips
        workflows={workflows}
        activeFilters={new Set()}
        onStatusClick={() => {}}
        queueStatus={queueStatus}
        onOpenRunningSurface={onOpenRunningSurface}
      />,
    );

    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (3/8)');
    expect(screen.getByTestId('queue-chip-queued')).toHaveTextContent('Queued (2)');
    expect(screen.getByTestId('workflow-status-pill-running')).toHaveTextContent('running (1)');

    fireEvent.click(screen.getByTestId('queue-chip-queued'));
    expect(onOpenRunningSurface).toHaveBeenCalledTimes(1);
  });
});
