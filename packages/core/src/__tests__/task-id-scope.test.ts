import { describe, it, expect } from 'vitest';
import { buildPlanLocalToScopedIdMap, scopePlanTaskId } from '../task-id-scope.js';

describe('task-id-scope', () => {
  it('scopePlanTaskId prefixes with workflow', () => {
    expect(scopePlanTaskId('wf-1', 't1')).toBe('wf-1/t1');
  });

  it('scopePlanTaskId leaves merge node ids unchanged', () => {
    expect(scopePlanTaskId('wf-1', '__merge__wf-1')).toBe('__merge__wf-1');
  });

  it('buildPlanLocalToScopedIdMap maps all tasks', () => {
    const m = buildPlanLocalToScopedIdMap('wf-9', [{ id: 'a' }, { id: 'b' }]);
    expect(m.get('a')).toBe('wf-9/a');
    expect(m.get('b')).toBe('wf-9/b');
  });

  it('buildPlanLocalToScopedIdMap throws on duplicate plan-local ids', () => {
    expect(() => buildPlanLocalToScopedIdMap('wf-1', [{ id: 'x' }, { id: 'x' }])).toThrow(/Duplicate task id/);
  });
});
