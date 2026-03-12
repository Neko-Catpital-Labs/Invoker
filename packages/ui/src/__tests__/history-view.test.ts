import { describe, it, expect } from 'vitest';
import { groupByWorkflow } from '../components/HistoryView.js';

function makeFakeTask(id: string, workflowName: string) {
  return {
    id,
    description: `Task ${id}`,
    status: 'completed' as const,
    dependencies: [] as string[],
    config: {},
    execution: {},
    workflowName,
  };
}

describe('groupByWorkflow', () => {
  it('groups tasks by workflow name', () => {
    const tasks = [
      makeFakeTask('t1', 'Plan A'),
      makeFakeTask('t2', 'Plan B'),
      makeFakeTask('t3', 'Plan A'),
    ];
    const grouped = groupByWorkflow(tasks as any);
    expect(grouped.size).toBe(2);
    expect(grouped.get('Plan A')).toHaveLength(2);
    expect(grouped.get('Plan B')).toHaveLength(1);
  });

  it('preserves insertion order within groups', () => {
    const tasks = [
      makeFakeTask('t1', 'Plan A'),
      makeFakeTask('t2', 'Plan A'),
      makeFakeTask('t3', 'Plan A'),
    ];
    const grouped = groupByWorkflow(tasks as any);
    const planA = grouped.get('Plan A')!;
    expect(planA[0].id).toBe('t1');
    expect(planA[1].id).toBe('t2');
    expect(planA[2].id).toBe('t3');
  });

  it('returns empty map for empty input', () => {
    const grouped = groupByWorkflow([]);
    expect(grouped.size).toBe(0);
  });

  it('handles single task', () => {
    const tasks = [makeFakeTask('t1', 'Solo Plan')];
    const grouped = groupByWorkflow(tasks as any);
    expect(grouped.size).toBe(1);
    expect(grouped.get('Solo Plan')).toHaveLength(1);
  });
});
