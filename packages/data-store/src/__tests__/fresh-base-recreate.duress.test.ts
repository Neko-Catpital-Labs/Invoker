import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';

describe('fresh-base recreate duress', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  const DEPS = [
    { workflowId: 'wf-upstream', taskId: '__merge__', requiredStatus: 'completed' as const },
  ];

  function stackedWorkflow(): Workflow {
    return {
      id: 'wf-downstream',
      name: 'Stacked downstream workflow',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baseBranch: 'plan/upstream',
      externalDependencies: DEPS,
    } as Workflow;
  }

  it('preserves externalDependencies across a storm of partial recreate writes', () => {
    adapter.saveWorkflow(stackedWorkflow());

    for (let i = 0; i < 60; i += 1) {
      switch (i % 4) {
        case 0:
          adapter.updateWorkflow('wf-downstream', { baseBranch: `plan/upstream-fresh-${i}` });
          break;
        case 1:
          adapter.updateWorkflow('wf-downstream', { generation: i });
          break;
        case 2:
          adapter.updateWorkflow('wf-downstream', {
            mergeMode: i % 8 === 2 ? 'automatic' : 'external_review',
          });
          break;
        default:
          adapter.updateWorkflow('wf-downstream', { branch: `integration-${i}` });
          break;
      }
      expect(adapter.loadWorkflow('wf-downstream')!.externalDependencies).toEqual(DEPS);
    }

    const finalState = adapter.loadWorkflow('wf-downstream')!;
    expect(finalState.externalDependencies).toEqual(DEPS);
    expect(finalState.baseBranch).toBe('plan/upstream-fresh-56');
  });

  it('still rejects an undocumented dependency drop under the storm, and allows an explicit detach', () => {
    adapter.saveWorkflow(stackedWorkflow());
    for (let i = 0; i < 10; i += 1) {
      adapter.updateWorkflow('wf-downstream', { baseBranch: `plan/upstream-fresh-${i}` });
    }

    expect(() => adapter.updateWorkflow('wf-downstream', { externalDependencies: undefined }))
      .toThrow(/without externalDependencyChanges/);
    expect(adapter.loadWorkflow('wf-downstream')!.externalDependencies).toEqual(DEPS);

    adapter.updateWorkflow('wf-downstream', {
      externalDependencies: undefined,
      externalDependencyChanges: [{ before: DEPS[0], changedAt: '2026-06-13T00:00:00.000Z' }],
    });
    expect(adapter.loadWorkflow('wf-downstream')!.externalDependencies).toBeUndefined();
  });
});
