import { describe, it, expect, beforeEach } from 'vitest';
import { createTestHarness, type TestHarness } from '@invoker/test-kit';
import type { PlanDefinition } from '@invoker/workflow-core';

const STORM_PLAN: PlanDefinition = {
  name: 'Reset Storm Duress',
  onFinish: 'merge',
  mergeMode: 'automatic',
  baseBranch: 'master',
  featureBranch: 'plan/reset-storm',
  tasks: [
    { id: 'A', description: 'Task A', command: 'echo a' },
    { id: 'B', description: 'Task B', command: 'echo b' },
    { id: 'C', description: 'Task C', command: 'echo c', dependencies: ['A'] },
    { id: 'D', description: 'Task D', command: 'echo d', dependencies: ['A', 'B'] },
  ],
};

// assertResetComplete throws messages of the form "Incomplete <kind> reset ...".
const RESET_INVARIANT = /Incomplete .* reset/;

function completeAllRunning(h: TestHarness): void {
  for (let guard = 0; guard < 100; guard += 1) {
    const running = h.getAllTasks().filter((t) => t.status === 'running');
    if (running.length === 0) return;
    for (const t of running) h.completeTask(t.id);
  }
}

describe('reset storm duress', () => {
  let h: TestHarness;
  beforeEach(() => {
    h = createTestHarness();
  });

  it('never leaves stale state across a storm of interleaved resets', () => {
    h.loadAndStart(STORM_PLAN);
    completeAllRunning(h);
    const wfId = h.getAllTasks()[0]?.config.workflowId;
    expect(wfId).toBeTruthy();

    const nonMerge = () => h.getAllTasks().filter((t) => !t.config.isMergeNode);

    for (let i = 0; i < 40; i += 1) {
      const targets = nonMerge();
      const target = targets[i % targets.length];
      try {
        switch (i % 5) {
          case 0:
            h.orchestrator.retryTask(target.id);
            break;
          case 1:
            h.orchestrator.recreateTask(target.id);
            break;
          case 2:
            h.orchestrator.retryWorkflow(wfId!);
            break;
          case 3:
            h.orchestrator.recreateWorkflow(wfId!);
            break;
          default:
            h.orchestrator.prepareTaskForNewAttempt(target.id, 'reset-storm');
            break;
        }
      } catch (err) {
        // A reset-completeness violation must fail the test. Benign
        // state-machine rejections under chaos (e.g. resetting an
        // already-pending task) are tolerated — they are not the boundary
        // under test.
        if (RESET_INVARIANT.test(String(err))) throw err;
      }
      // Re-drive whatever became runnable so the next reset acts on a task that
      // has accumulated execution state (branch, commit, timing) to clear.
      completeAllRunning(h);
    }

    // Final explicit proof: a recreate after the storm yields a fully clean
    // task — fresh-lineage fields cleared per the rulebook.
    const victim = nonMerge()[0];
    h.completeTask(victim.id);
    h.orchestrator.recreateTask(victim.id);
    const after = h.getTask(victim.id)!;
    expect(after.execution.branch).toBeUndefined();
    expect(after.execution.commit).toBeUndefined();
    expect(after.execution.workspacePath).toBeUndefined();
    expect(after.execution.error).toBeUndefined();
  });
});
