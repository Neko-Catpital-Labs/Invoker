import { describe, expect, it } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import { buildConflictHeatmap } from '../conflict-heatmap.js';
import { formatConflictHeatmap, serializeConflictHeatmapRow } from '../formatter.js';

function task(id: string, workflowId: string, conflictFiles: string[], createdAt: string): TaskState {
  return {
    id,
    description: id,
    status: 'failed',
    dependencies: [],
    createdAt: new Date(createdAt),
    config: { workflowId },
    execution: {
      mergeConflict: {
        failedBranch: `branch/${id}`,
        conflictFiles,
      },
    },
  } as TaskState;
}

describe('conflict heatmap', () => {
  it('ranks conflict files across workflows', () => {
    const rows = buildConflictHeatmap({
      listWorkflows: () => [{ id: 'wf-1' }, { id: 'wf-2' }],
      loadTasks: (workflowId) => workflowId === 'wf-1'
        ? [
            task('wf-1/a', 'wf-1', ['packages/app/src/main.ts', 'README.md'], '2026-01-01T00:00:00Z'),
            task('wf-1/b', 'wf-1', ['packages/app/src/main.ts'], '2026-01-02T00:00:00Z'),
          ]
        : [
            task('wf-2/c', 'wf-2', ['packages/app/src/headless.ts'], '2026-01-03T00:00:00Z'),
          ],
    });

    expect(rows[0]).toEqual({
      file: 'packages/app/src/main.ts',
      count: 2,
      workflowIds: ['wf-1'],
      taskIds: ['wf-1/a', 'wf-1/b'],
      latestTaskId: 'wf-1/b',
    });
    expect(rows.map(row => row.file)).toEqual([
      'packages/app/src/main.ts',
      'packages/app/src/headless.ts',
      'README.md',
    ]);
  });

  it('formats text and JSON-safe rows', () => {
    const row = {
      file: 'packages/app/src/main.ts',
      count: 2,
      workflowIds: ['wf-1'],
      taskIds: ['wf-1/a', 'wf-1/b'],
      latestTaskId: 'wf-1/b',
    };

    expect(formatConflictHeatmap([row])).toContain('packages/app/src/main.ts');
    expect(serializeConflictHeatmapRow(row)).toEqual(row);
  });
});
