import { describe, it, expect } from 'vitest';
import type { TaskState } from '../task-types.js';
import {
  topologicalSort,
  getTransitiveDependents,
  validateDAG,
  computeLevels,
  getReadyTasks,
} from '../dag.js';

function makeTask(
  id: string,
  deps: string[] = [],
  status: TaskState['status'] = 'pending',
): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status,
    dependencies: deps,
    createdAt: new Date(),
  };
}

// ── topologicalSort ──────────────────────────────────────────

describe('topologicalSort', () => {
  it('sorts a linear chain A -> B -> C', () => {
    const tasks = [
      makeTask('C', ['B']),
      makeTask('B', ['A']),
      makeTask('A'),
    ];
    const sorted = topologicalSort(tasks);
    const ids = sorted.map((t) => t.id);

    // A must come before B, B must come before C
    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('B'));
    expect(ids.indexOf('B')).toBeLessThan(ids.indexOf('C'));
  });

  it('sorts a diamond A -> B,C -> D', () => {
    const tasks = [
      makeTask('D', ['B', 'C']),
      makeTask('B', ['A']),
      makeTask('C', ['A']),
      makeTask('A'),
    ];
    const sorted = topologicalSort(tasks);
    const ids = sorted.map((t) => t.id);

    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('B'));
    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('C'));
    expect(ids.indexOf('B')).toBeLessThan(ids.indexOf('D'));
    expect(ids.indexOf('C')).toBeLessThan(ids.indexOf('D'));
  });

  it('handles disconnected components', () => {
    const tasks = [
      makeTask('A'),
      makeTask('B'),
      makeTask('C', ['A']),
    ];
    const sorted = topologicalSort(tasks);
    const ids = sorted.map((t) => t.id);

    expect(ids).toHaveLength(3);
    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('C'));
    // B can be anywhere — just verify all tasks are present
    expect(ids).toContain('B');
  });

  it('throws on cycle', () => {
    const tasks = [
      makeTask('A', ['B']),
      makeTask('B', ['A']),
    ];
    expect(() => topologicalSort(tasks)).toThrow(/cycle/i);
  });

  it('returns empty array for empty input', () => {
    expect(topologicalSort([])).toEqual([]);
  });
});

// ── validateDAG ──────────────────────────────────────────────

describe('validateDAG', () => {
  it('detects a cycle', () => {
    const tasks = [
      makeTask('A', ['B']),
      makeTask('B', ['C']),
      makeTask('C', ['A']),
    ];
    const result = validateDAG(tasks);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /cycle/i.test(e))).toBe(true);
  });

  it('detects missing dependency reference', () => {
    const tasks = [
      makeTask('A', ['nonexistent']),
    ];
    const result = validateDAG(tasks);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /nonexistent/i.test(e))).toBe(true);
  });

  it('returns valid for a correct DAG', () => {
    const tasks = [
      makeTask('A'),
      makeTask('B', ['A']),
      makeTask('C', ['A', 'B']),
    ];
    const result = validateDAG(tasks);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports both missing refs and cycles', () => {
    const tasks = [
      makeTask('A', ['B']),
      makeTask('B', ['A']),
      makeTask('C', ['missing']),
    ];
    const result = validateDAG(tasks);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /cycle/i.test(e))).toBe(true);
    expect(result.errors.some((e) => /missing/i.test(e))).toBe(true);
  });
});

// ── getTransitiveDependents ──────────────────────────────────

describe('getTransitiveDependents', () => {
  it('finds all downstream tasks', () => {
    // A -> B -> D
    // A -> C -> D
    const tasks = [
      makeTask('A'),
      makeTask('B', ['A']),
      makeTask('C', ['A']),
      makeTask('D', ['B', 'C']),
    ];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const dependents = getTransitiveDependents('A', taskMap);

    expect(dependents.sort()).toEqual(['B', 'C', 'D']);
  });

  it('returns empty array for a leaf task', () => {
    const tasks = [
      makeTask('A'),
      makeTask('B', ['A']),
    ];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const dependents = getTransitiveDependents('B', taskMap);

    expect(dependents).toEqual([]);
  });

  it('handles mid-chain correctly', () => {
    // A -> B -> C -> D
    const tasks = [
      makeTask('A'),
      makeTask('B', ['A']),
      makeTask('C', ['B']),
      makeTask('D', ['C']),
    ];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const dependents = getTransitiveDependents('B', taskMap);

    expect(dependents.sort()).toEqual(['C', 'D']);
  });
});

// ── computeLevels ────────────────────────────────────────────

describe('computeLevels', () => {
  it('assigns correct depth per task', () => {
    // A(0) -> B(1) -> D(2)
    // A(0) -> C(1) -> D(2)
    const tasks = [
      makeTask('A'),
      makeTask('B', ['A']),
      makeTask('C', ['A']),
      makeTask('D', ['B', 'C']),
    ];
    const levels = computeLevels(tasks);

    expect(levels.get('A')).toBe(0);
    expect(levels.get('B')).toBe(1);
    expect(levels.get('C')).toBe(1);
    expect(levels.get('D')).toBe(2);
  });

  it('assigns level 0 to all independent tasks', () => {
    const tasks = [
      makeTask('A'),
      makeTask('B'),
      makeTask('C'),
    ];
    const levels = computeLevels(tasks);

    expect(levels.get('A')).toBe(0);
    expect(levels.get('B')).toBe(0);
    expect(levels.get('C')).toBe(0);
  });

  it('handles a long chain', () => {
    const tasks = [
      makeTask('A'),
      makeTask('B', ['A']),
      makeTask('C', ['B']),
      makeTask('D', ['C']),
    ];
    const levels = computeLevels(tasks);

    expect(levels.get('A')).toBe(0);
    expect(levels.get('B')).toBe(1);
    expect(levels.get('C')).toBe(2);
    expect(levels.get('D')).toBe(3);
  });
});

// ── getReadyTasks ────────────────────────────────────────────

describe('getReadyTasks', () => {
  it('returns pending tasks whose dependencies are all completed', () => {
    const tasks = [
      makeTask('A', [], 'completed'),
      makeTask('B', ['A'], 'pending'),
      makeTask('C', ['A'], 'running'),
      makeTask('D', ['B'], 'pending'),
    ];
    const ready = getReadyTasks(tasks);
    const ids = ready.map((t) => t.id);

    // B is pending and its dep A is completed -> ready
    // C is running -> not ready (not pending)
    // D is pending but dep B is not completed -> not ready
    expect(ids).toEqual(['B']);
  });

  it('returns tasks with no dependencies if they are pending', () => {
    const tasks = [
      makeTask('A', [], 'pending'),
      makeTask('B', [], 'completed'),
      makeTask('C', ['B'], 'pending'),
    ];
    const ready = getReadyTasks(tasks);
    const ids = ready.map((t) => t.id);

    expect(ids).toContain('A');
    expect(ids).toContain('C');
    expect(ids).toHaveLength(2);
  });

  it('returns empty array when nothing is ready', () => {
    const tasks = [
      makeTask('A', [], 'running'),
      makeTask('B', ['A'], 'pending'),
    ];
    const ready = getReadyTasks(tasks);

    expect(ready).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(getReadyTasks([])).toEqual([]);
  });
});
