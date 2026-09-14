import type { ValidationResult } from './validation.ts';

export const TASK_FILTER_KEYS = [
  'id',
  'workflow_id',
  'status',
  'failure_class',
  'execution_agent',
  'execution_model',
  'pool_member_id',
  'repo_url',
  'branch',
  'description',
  'error',
  'is_merge_node',
  'created_at',
  'started_at',
  'completed_at',
  'last_heartbeat_at',
] as const;

export const TASK_FILTER_TIME_KEYS = ['created_at', 'started_at', 'completed_at', 'last_heartbeat_at'] as const;

export type TaskFilterKey = (typeof TASK_FILTER_KEYS)[number];
export type TaskFilterTimeKey = (typeof TASK_FILTER_TIME_KEYS)[number];
export type TaskFilterValue = string | number | boolean | null;

export type TaskFilterNode =
  | { op: 'and'; filters: TaskFilterNode[] }
  | { op: 'or'; filters: TaskFilterNode[] }
  | { op: 'not'; filter: TaskFilterNode }
  | { op: 'exists'; key: TaskFilterKey }
  | { op: 'eq'; key: TaskFilterKey; value: TaskFilterValue }
  | { op: 'in'; key: TaskFilterKey; values: TaskFilterValue[] }
  | { op: 'contains'; key: TaskFilterKey; value: string }
  | { op: 'time_range'; key: TaskFilterTimeKey; start?: string; end?: string };

const taskFilterKeySet = new Set<string>(TASK_FILTER_KEYS);
const taskFilterTimeKeySet = new Set<string>(TASK_FILTER_TIME_KEYS);
const filterOps = new Set(['and', 'or', 'not', 'exists', 'eq', 'in', 'contains', 'time_range']);
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTaskFilterValue(value: unknown): value is TaskFilterValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function hasOnlyFields(record: Record<string, unknown>, fields: readonly string[], path: string): ValidationResult {
  const allowed = new Set(fields);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      return { valid: false, error: `${path}.${field} is not allowed` };
    }
  }
  return { valid: true };
}

function validateKey(value: unknown, path: string): ValidationResult {
  if (typeof value !== 'string' || !taskFilterKeySet.has(value)) {
    return { valid: false, error: `${path} must be a valid task filter key` };
  }
  return { valid: true };
}

function validateTimeKey(value: unknown, path: string): ValidationResult {
  if (typeof value !== 'string' || !taskFilterTimeKeySet.has(value)) {
    return { valid: false, error: `${path} must be a task timestamp column` };
  }
  return { valid: true };
}

function validateIsoTimestamp(value: unknown, path: string): ValidationResult {
  if (typeof value !== 'string' || !isoTimestampPattern.test(value) || Number.isNaN(Date.parse(value))) {
    return { valid: false, error: `${path} must be a timezone-qualified ISO timestamp` };
  }
  return { valid: true };
}

function validateNode(input: unknown, depth: number, path: string): ValidationResult {
  if (depth > 8) {
    return { valid: false, error: `${path} exceeds the maximum nesting depth of 8` };
  }
  if (!isRecord(input)) {
    return { valid: false, error: `${path} must be an object` };
  }
  if (typeof input.op !== 'string' || !filterOps.has(input.op)) {
    return { valid: false, error: `${path}.op must be a known task filter operation` };
  }

  const op = input.op;
  if (op === 'and' || op === 'or') {
    const fields = hasOnlyFields(input, ['op', 'filters'], path);
    if (!fields.valid) return fields;
    if (!Array.isArray(input.filters) || input.filters.length === 0) {
      return { valid: false, error: `${path}.filters must be a non-empty array` };
    }
    for (let i = 0; i < input.filters.length; i += 1) {
      const result = validateNode(input.filters[i], depth + 1, `${path}.filters[${i}]`);
      if (!result.valid) return result;
    }
    return { valid: true };
  }

  if (op === 'not') {
    const fields = hasOnlyFields(input, ['op', 'filter'], path);
    if (!fields.valid) return fields;
    return validateNode(input.filter, depth + 1, `${path}.filter`);
  }

  const fields = hasOnlyFields(
    input,
    op === 'exists' ? ['op', 'key'] : op === 'in' ? ['op', 'key', 'values'] : op === 'time_range' ? ['op', 'key', 'start', 'end'] : ['op', 'key', 'value'],
    path,
  );
  if (!fields.valid) return fields;
  const keyResult = op === 'time_range' ? validateTimeKey(input.key, `${path}.key`) : validateKey(input.key, `${path}.key`);
  if (!keyResult.valid) return keyResult;

  if (op === 'exists') return { valid: true };
  if (op === 'contains') {
    return typeof input.value === 'string'
      ? { valid: true }
      : { valid: false, error: `${path}.value must be a string` };
  }
  if (op === 'eq') {
    return isTaskFilterValue(input.value)
      ? { valid: true }
      : { valid: false, error: `${path}.value must be a scalar value` };
  }
  if (op === 'in') {
    if (!Array.isArray(input.values) || input.values.length === 0) {
      return { valid: false, error: `${path}.values must be a non-empty array` };
    }
    for (let i = 0; i < input.values.length; i += 1) {
      if (!isTaskFilterValue(input.values[i])) {
        return { valid: false, error: `${path}.values[${i}] must be a scalar value` };
      }
    }
    return { valid: true };
  }

  if (input.start === undefined && input.end === undefined) {
    return { valid: false, error: `${path}.start or ${path}.end is required` };
  }
  if (input.start !== undefined) {
    const result = validateIsoTimestamp(input.start, `${path}.start`);
    if (!result.valid) return result;
  }
  if (input.end !== undefined) {
    const result = validateIsoTimestamp(input.end, `${path}.end`);
    if (!result.valid) return result;
  }
  if (input.start !== undefined && input.end !== undefined && Date.parse(input.start as string) > Date.parse(input.end as string)) {
    return { valid: false, error: `${path}.start must not be after ${path}.end` };
  }
  return { valid: true };
}

export function validateTaskFilter(input: unknown): ValidationResult {
  return validateNode(input, 1, 'taskFilter');
}
