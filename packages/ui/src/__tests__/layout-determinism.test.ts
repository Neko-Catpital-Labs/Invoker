/**
 * Layout determinism tests — verify that layoutNodes produces identical output
 * regardless of input array order, and that sortedWorkflowGroups + layoutNodes
 * produces stable positions across different task insertion orders.
 */

import { describe, it, expect } from 'vitest';
import { layoutNodes } from '../lib/layout.js';
import { groupTasksByWorkflow, sortedWorkflowGroups } from '../lib/merge-gate.js';
import type { TaskState } from '../types.js';

function makeTask(
  id: string,
  deps: string[] = [],
  workflowId?: string,
): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status: 'pending',
    dependencies: deps,
    createdAt: new Date('2025-01-01'),
    config: workflowId ? { workflowId } : {},
    execution: {},
  };
}

/** All permutations of an array (for small arrays only). */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  return arr.flatMap((item, i) =>
    permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('layoutNodes — input-order determinism', () => {
  it('produces identical positions for a diamond DAG across all input permutations', () => {
    // Diamond: root -> mid1, mid2 -> leaf
    const tasks = [
      makeTask('root'),
      makeTask('mid1', ['root']),
      makeTask('mid2', ['root']),
      makeTask('leaf', ['mid1', 'mid2']),
    ];

    const reference = layoutNodes(tasks);

    for (const perm of permutations(tasks)) {
      const result = layoutNodes(perm);
      for (const task of tasks) {
        expect(result.get(task.id)).toEqual(reference.get(task.id));
      }
    }
  });

  it('produces identical positions for a multi-level DAG with shared dependencies', () => {
    // a, b -> c; a, c -> d; b -> e; c, e -> f
    const tasks = [
      makeTask('a'),
      makeTask('b'),
      makeTask('c', ['a', 'b']),
      makeTask('d', ['a', 'c']),
      makeTask('e', ['b']),
      makeTask('f', ['c', 'e']),
    ];

    const reference = layoutNodes(tasks);

    // Test several shuffles (not all 720 permutations — just enough coverage)
    const shuffles: TaskState[][] = [
      [tasks[5], tasks[4], tasks[3], tasks[2], tasks[1], tasks[0]],
      [tasks[2], tasks[0], tasks[4], tasks[1], tasks[5], tasks[3]],
      [tasks[1], tasks[3], tasks[0], tasks[5], tasks[2], tasks[4]],
    ];

    for (const shuffled of shuffles) {
      const result = layoutNodes(shuffled);
      for (const task of tasks) {
        expect(result.get(task.id)).toEqual(reference.get(task.id));
      }
    }
  });

  it('produces identical positions for disconnected components in any order', () => {
    // Two independent chains: a->b->c and x->y
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['b']),
      makeTask('x'),
      makeTask('y', ['x']),
    ];

    const reference = layoutNodes(tasks);

    const shuffled = [tasks[3], tasks[0], tasks[4], tasks[2], tasks[1]];
    const result = layoutNodes(shuffled);

    for (const task of tasks) {
      expect(result.get(task.id)).toEqual(reference.get(task.id));
    }
  });

  it('produces identical positions for a wide fan-in across all input permutations', () => {
    // a, b, c, d all feed into sink
    const tasks = [
      makeTask('a'),
      makeTask('b'),
      makeTask('c'),
      makeTask('d'),
      makeTask('sink', ['a', 'b', 'c', 'd']),
    ];

    const reference = layoutNodes(tasks);

    for (const perm of permutations(tasks)) {
      const result = layoutNodes(perm);
      for (const task of tasks) {
        expect(result.get(task.id)).toEqual(reference.get(task.id));
      }
    }
  });

  it('map size equals task count regardless of input order', () => {
    const tasks = [
      makeTask('p'),
      makeTask('q', ['p']),
      makeTask('r', ['p', 'q']),
      makeTask('s', ['r']),
    ];

    for (const perm of permutations(tasks)) {
      expect(layoutNodes(perm).size).toBe(tasks.length);
    }
  });
});

describe('groupTasksByWorkflow + sortedWorkflowGroups — insertion-order determinism', () => {
  /**
   * Simulate the pattern used by TaskDAG: group by workflow, sort groups, then
   * layout the combined sorted task list. Two different insertion orders for the
   * same task set should yield the same positions.
   */
  function layoutViaWorkflowGroups(tasks: TaskState[]): Map<string, { x: number; y: number }> {
    const groups = groupTasksByWorkflow(tasks);
    const sorted = sortedWorkflowGroups(groups);
    const orderedTasks = sorted.flatMap(([, wfTasks]) => wfTasks);
    return layoutNodes(orderedTasks);
  }

  it('produces identical positions for two workflows with tasks in different insertion orders', () => {
    // Workflow "wf-1": a -> b -> c
    // Workflow "wf-2": x -> y
    const wf1Tasks = [
      makeTask('a', [], 'wf-1'),
      makeTask('b', ['a'], 'wf-1'),
      makeTask('c', ['b'], 'wf-1'),
    ];
    const wf2Tasks = [
      makeTask('x', [], 'wf-2'),
      makeTask('y', ['x'], 'wf-2'),
    ];

    // Insertion order 1: wf-1 first, then wf-2
    const order1 = [...wf1Tasks, ...wf2Tasks];
    // Insertion order 2: wf-2 first, then wf-1
    const order2 = [...wf2Tasks, ...wf1Tasks];
    // Insertion order 3: interleaved
    const order3 = [wf1Tasks[0], wf2Tasks[0], wf1Tasks[1], wf2Tasks[1], wf1Tasks[2]];

    const pos1 = layoutViaWorkflowGroups(order1);
    const pos2 = layoutViaWorkflowGroups(order2);
    const pos3 = layoutViaWorkflowGroups(order3);

    const allTasks = [...wf1Tasks, ...wf2Tasks];
    for (const task of allTasks) {
      expect(pos2.get(task.id)).toEqual(pos1.get(task.id));
      expect(pos3.get(task.id)).toEqual(pos1.get(task.id));
    }
  });

  it('sortedWorkflowGroups is stable: same workflow ordering regardless of Map insertion order', () => {
    const taskSet1 = [
      makeTask('a', [], 'alpha'),
      makeTask('b', [], 'beta'),
      makeTask('c', [], 'gamma'),
    ];
    // Insert in reverse workflow order
    const taskSet2 = [
      makeTask('c', [], 'gamma'),
      makeTask('b', [], 'beta'),
      makeTask('a', [], 'alpha'),
    ];

    const groups1 = sortedWorkflowGroups(groupTasksByWorkflow(taskSet1));
    const groups2 = sortedWorkflowGroups(groupTasksByWorkflow(taskSet2));

    // Same workflow IDs in same order
    expect(groups1.map(([wfId]) => wfId)).toEqual(groups2.map(([wfId]) => wfId));
  });

  it("'unknown' workflow is always sorted last", () => {
    const tasks = [
      makeTask('u1'),          // no workflowId → 'unknown'
      makeTask('a1', [], 'aaa'),
      makeTask('z1', [], 'zzz'),
    ];

    const groups = sortedWorkflowGroups(groupTasksByWorkflow(tasks));
    const wfIds = groups.map(([wfId]) => wfId);

    expect(wfIds[wfIds.length - 1]).toBe('unknown');
    // 'aaa' before 'zzz' alphabetically
    expect(wfIds.indexOf('aaa')).toBeLessThan(wfIds.indexOf('zzz'));
  });

  it('positions are stable across all permutations of a three-workflow task set', () => {
    const tasks = [
      makeTask('p1', [], 'plan-1'),
      makeTask('p2', ['p1'], 'plan-1'),
      makeTask('q1', [], 'plan-2'),
      makeTask('q2', ['q1'], 'plan-2'),
      makeTask('r1', [], 'plan-3'),
    ];

    const reference = layoutViaWorkflowGroups(tasks);

    for (const perm of permutations(tasks)) {
      const result = layoutViaWorkflowGroups(perm);
      for (const task of tasks) {
        expect(result.get(task.id)).toEqual(reference.get(task.id));
      }
    }
  });
});
