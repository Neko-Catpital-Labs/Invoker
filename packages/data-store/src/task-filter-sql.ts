import type { TaskFilterKey, TaskFilterNode, TaskFilterValue } from '@invoker/contracts';

export interface CompiledTaskFilter {
  where: string;
  params: unknown[];
}

const TASK_FILTER_COLUMNS: Record<TaskFilterKey, string> = {
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
  if (!Object.hasOwn(TASK_FILTER_COLUMNS, key)) throw new Error(`Unknown task filter key: ${key}`);
  return TASK_FILTER_COLUMNS[key as TaskFilterKey];
}

function bindValue(value: TaskFilterValue): unknown {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function escapeLikeValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function compileNode(node: TaskFilterNode, params: unknown[]): string {
  switch (node.op) {
    case 'and':
    case 'or':
      return `(${node.filters.map((child) => compileNode(child, params)).join(node.op === 'and' ? ' AND ' : ' OR ')})`;
    case 'not':
      return `(NOT ${compileNode(node.filter, params)})`;
    case 'exists': {
      const column = columnFor(node.key);
      return `(${column} IS NOT NULL AND ${column} != '')`;
    }
    case 'eq': {
      const column = columnFor(node.key);
      params.push(bindValue(node.value));
      return `${column} = ?`;
    }
    case 'in': {
      const column = columnFor(node.key);
      params.push(...node.values.map(bindValue));
      return `${column} IN (${node.values.map(() => '?').join(', ')})`;
    }
    case 'contains': {
      const column = columnFor(node.key);
      params.push(`%${escapeLikeValue(node.value)}%`);
      return `${column} LIKE ? ESCAPE '\\'`;
    }
    case 'time_range': {
      const column = columnFor(node.key);
      const clauses: string[] = [];
      if (node.start !== undefined) {
        clauses.push(`${column} >= ?`);
        params.push(node.start);
      }
      if (node.end !== undefined) {
        clauses.push(`${column} <= ?`);
        params.push(node.end);
      }
      return clauses.length === 1 ? clauses[0] : `(${clauses.join(' AND ')})`;
    }
  }
}

export function compileTaskFilter(filter: TaskFilterNode): CompiledTaskFilter {
  const params: unknown[] = [];
  return { where: compileNode(filter, params), params };
}
