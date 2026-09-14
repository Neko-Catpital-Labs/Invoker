import { describe, expect, it } from 'vitest';
import { TASK_FILTER_KEYS, TASK_FILTER_TIME_KEYS, validateTaskFilter } from '../task-filter.js';

const validLeaf = { op: 'eq', key: 'status', value: 'failed' } as const;

function expectReject(input: unknown, field: string) {
  const result = validateTaskFilter(input);
  expect(result.valid).toBe(false);
  expect(result.error).toContain(field);
}

describe('validateTaskFilter', () => {
  it('exports exactly the task column allowlist', () => {
    expect(TASK_FILTER_KEYS).toEqual([
      'id', 'workflow_id', 'status', 'failure_class', 'execution_agent', 'execution_model',
      'pool_member_id', 'repo_url', 'branch', 'description', 'error', 'is_merge_node',
      'created_at', 'started_at', 'completed_at', 'last_heartbeat_at',
    ]);
  });

  it('exports only timestamp columns as time range keys', () => {
    expect(TASK_FILTER_TIME_KEYS).toEqual(['created_at', 'started_at', 'completed_at', 'last_heartbeat_at']);
    for (const key of TASK_FILTER_TIME_KEYS) expect(TASK_FILTER_KEYS).toContain(key);
  });

  it.each([
    ['and', { op: 'and', filters: [validLeaf] }],
    ['or', { op: 'or', filters: [validLeaf] }],
    ['not', { op: 'not', filter: validLeaf }],
    ['exists', { op: 'exists', key: 'error' }],
    ['eq', validLeaf],
    ['in', { op: 'in', key: 'status', values: ['queued', 'failed'] }],
    ['contains', { op: 'contains', key: 'description', value: 'needle' }],
    ['time_range with start', { op: 'time_range', key: 'created_at', start: '2026-01-01T00:00:00Z' }],
    ['time_range with end', { op: 'time_range', key: 'created_at', end: '2026-01-02T00:00:00+00:00' }],
    ['time_range with both bounds', { op: 'time_range', key: 'created_at', start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' }],
    ...TASK_FILTER_TIME_KEYS.map((key) => [`time_range on ${key}`, { op: 'time_range', key, start: '2026-01-01T00:00:00Z' }] as const),
  ])('accepts %s', (_, input) => {
    expect(validateTaskFilter(input).valid).toBe(true);
  });

  it('accepts nested filters through depth 8', () => {
    let input: unknown = validLeaf;
    for (let i = 0; i < 7; i += 1) input = { op: 'not', filter: input };
    expect(validateTaskFilter(input).valid).toBe(true);
  });

  it('rejects non-object input', () => {
    for (const input of [null, undefined, 'filter', 42, []]) {
      const result = validateTaskFilter(input);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('taskFilter');
    }
  });

  it('rejects an unknown operation', () => expectReject({ op: 'like', key: 'status', value: 'failed' }, 'taskFilter.op'));
  it('rejects an unknown key', () => expectReject({ op: 'eq', key: 'not_a_column', value: 'x' }, 'taskFilter.key'));
  it('rejects empty logical lists', () => expectReject({ op: 'and', filters: [] }, 'taskFilter.filters'));
  it('rejects empty in lists', () => expectReject({ op: 'in', key: 'status', values: [] }, 'taskFilter.values'));
  it('rejects non-string contains values', () => expectReject({ op: 'contains', key: 'description', value: 1 }, 'taskFilter.value'));
  it('rejects time ranges on non-timestamp keys', () => expectReject({ op: 'time_range', key: 'status', start: '2026-01-01T00:00:00Z' }, 'taskFilter.key'));
  it('rejects time ranges with no bound', () => expectReject({ op: 'time_range', key: 'created_at' }, 'taskFilter.start'));
  it('rejects naive timestamps', () => expectReject({ op: 'time_range', key: 'created_at', start: '2026-01-01T00:00:00' }, 'taskFilter.start'));
  it('rejects invalid timestamps', () => expectReject({ op: 'time_range', key: 'created_at', start: 'not-a-date' }, 'taskFilter.start'));
  it('rejects reversed time ranges', () => expectReject({ op: 'time_range', key: 'created_at', start: '2026-01-02T00:00:00Z', end: '2026-01-01T00:00:00Z' }, 'taskFilter.start'));
  it('rejects unknown fields to preserve the exact shape', () => expectReject({ op: 'exists', key: 'status', extra: true }, 'taskFilter.extra'));
  it('rejects nesting deeper than 8', () => {
    let input: unknown = validLeaf;
    for (let i = 0; i < 8; i += 1) input = { op: 'not', filter: input };
    expectReject(input, 'taskFilter.filter');
  });
});
