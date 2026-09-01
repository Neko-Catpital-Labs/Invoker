import type { TaskFilterKey, TaskFilterNode, TaskFilterValue } from '@invoker/contracts';

export interface CompiledTaskFilter {
  where: string;
  params: TaskFilterValue[];
}

const COLUMN_BY_KEY: Record<TaskFilterKey, string> = {
  id: 't.id',
  workflow_id: 't.workflow_id',
  status: 't.status',
  failure_class: 't.failure_class',
  execution_agent: 't.execution_agent',
  execution_model: 't.execution_model',
  pool_member_id: 't.pool_member_id',
  repo_url: 't.repo_url',
  branch: 't.branch',
  description: 't.description',
  error: 't.error',
  is_merge_node: 't.is_merge_node',
  created_at: 't.created_at',
  started_at: 't.started_at',
  completed_at: 't.completed_at',
  last_heartbeat_at: 't.last_heartbeat_at',
};

function columnFor(key: string): string {
  const column = COLUMN_BY_KEY[key as TaskFilterKey];
  if (!column) throw new Error(`Unknown task filter key: ${key}`);
  return column;
}

function bindValue(value: TaskFilterValue): TaskFilterValue {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function compileNode(node: TaskFilterNode, params: TaskFilterValue[]): string {
  if (node.op === 'and' || node.op === 'or') {
    if (node.filters.length === 0) throw new Error(`${node.op} requires at least one filter`);
    return `(${node.filters.map((child) => compileNode(child, params)).join(` ${node.op.toUpperCase()} `)})`;
  }
  if (node.op === 'not') return `(NOT ${compileNode(node.filter, params)})`;

  const column = columnFor(String(node.key));
  if (node.op === 'exists') return `(${column} IS NOT NULL AND ${column} != '')`;
  if (node.op === 'eq') {
    params.push(bindValue(node.value));
    return `(${column} = ?)`;
  }
  if (node.op === 'in') {
    params.push(...node.values.map(bindValue));
    return `(${column} IN (${node.values.map(() => '?').join(', ')}))`;
  }
  if (node.op === 'contains') {
    params.push(`%${escapeLike(node.value)}%`);
    return `(${column} LIKE ? ESCAPE '\\')`;
  }
  if (node.op === 'time_range') {
    const clauses: string[] = [];
    if (node.start !== undefined) {
      params.push(node.start);
      clauses.push(`${column} >= ?`);
    }
    if (node.end !== undefined) {
      params.push(node.end);
      clauses.push(`${column} <= ?`);
    }
    if (clauses.length === 0) throw new Error('time_range requires a start or end bound');
    return `(${clauses.join(' AND ')})`;
  }
  throw new Error(`Unknown task filter operation: ${String((node as { op?: unknown }).op)}`);
}

export function compileTaskFilter(filter: TaskFilterNode): CompiledTaskFilter {
  const params: TaskFilterValue[] = [];
  return { where: compileNode(filter, params), params };
}
