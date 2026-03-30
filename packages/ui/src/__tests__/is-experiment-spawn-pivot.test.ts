import { describe, it, expect } from 'vitest';
import {
  isExperimentSpawnPivotTask,
  EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE,
} from '../isExperimentSpawnPivot.js';
import type { TaskState } from '../types.js';

function baseTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 't1',
    description: 'Test',
    status: 'completed',
    dependencies: [],
    createdAt: new Date(),
    config: {},
    execution: {},
    ...overrides,
  };
}

describe('isExperimentSpawnPivotTask', () => {
  it('returns true when pivot and experimentVariants non-empty', () => {
    const task = baseTask({
      config: {
        pivot: true,
        experimentVariants: [{ id: 'a', description: 'A', prompt: 'p' }],
      },
    });
    expect(isExperimentSpawnPivotTask(task)).toBe(true);
  });

  it('returns false when pivot without variants', () => {
    expect(isExperimentSpawnPivotTask(baseTask({ config: { pivot: true } }))).toBe(false);
  });

  it('returns false when variants without pivot', () => {
    const task = baseTask({
      config: {
        experimentVariants: [{ id: 'a', description: 'A', prompt: 'p' }],
      },
    });
    expect(isExperimentSpawnPivotTask(task)).toBe(false);
  });

  it('returns false when experimentVariants empty', () => {
    const task = baseTask({
      config: { pivot: true, experimentVariants: [] },
    });
    expect(isExperimentSpawnPivotTask(task)).toBe(false);
  });

  it('exports a non-empty user message', () => {
    expect(EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE.length).toBeGreaterThan(20);
    expect(EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE).toContain('exp');
  });
});
