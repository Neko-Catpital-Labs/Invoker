/**
 * Shared classifier for headless CLI commands.
 *
 * This is used by both:
 * - main.ts (pre-init routing/delegation decisions)
 * - tests/policy checks to keep command routing behavior consistent
 */

import type { PersistenceAdapter } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

export type HeadlessTargetLookup = Pick<PersistenceAdapter, 'loadWorkflow' | 'listWorkflows' | 'loadTasks'>;

export type HeadlessTargetResolution =
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'task'; workflowId: string; taskId: string; resolvedTaskId: string }
  | { kind: 'unknown'; target: string };

function looksLikeWorkflowId(target: string): boolean {
  return /^wf-[^/]+$/.test(target);
}

function parseWorkflowIdFromTaskTarget(target: string): string | null {
  const slashIndex = target.indexOf('/');
  if (slashIndex <= 0) return null;
  const workflowId = target.slice(0, slashIndex);
  return looksLikeWorkflowId(workflowId) ? workflowId : null;
}

function findStoredTaskByTarget(
  lookup: HeadlessTargetLookup,
  target: string,
): { workflowId: string; task: TaskState } | null {
  for (const workflow of lookup.listWorkflows()) {
    const task = lookup.loadTasks(workflow.id).find((candidate) => (
      candidate.id === target || candidate.id.endsWith(`/${target}`)
    ));
    if (task) {
      return { workflowId: workflow.id, task };
    }
  }
  return null;
}

export function resolveHeadlessTarget(
  targetArg: unknown,
  lookup: HeadlessTargetLookup,
): HeadlessTargetResolution {
  const target = String(targetArg ?? '');
  if (!target) {
    return { kind: 'unknown', target: '' };
  }

  if (looksLikeWorkflowId(target)) {
    return { kind: 'workflow', workflowId: target };
  }

  const workflowIdFromTaskTarget = parseWorkflowIdFromTaskTarget(target);
  if (workflowIdFromTaskTarget) {
    return {
      kind: 'task',
      workflowId: workflowIdFromTaskTarget,
      taskId: target,
      resolvedTaskId: target,
    };
  }

  const workflow = lookup.loadWorkflow(target);
  if (workflow) {
    return { kind: 'workflow', workflowId: workflow.id };
  }

  const storedTask = findStoredTaskByTarget(lookup, target);
  if (storedTask) {
    return {
      kind: 'task',
      workflowId: storedTask.workflowId,
      taskId: target,
      resolvedTaskId: storedTask.task.id,
    };
  }

  return { kind: 'unknown', target };
}

export function resolveHeadlessTargetWorkflowId(
  targetArg: unknown,
  lookup: HeadlessTargetLookup,
): string {
  const resolved = resolveHeadlessTarget(targetArg, lookup);
  if (resolved.kind === 'workflow' || resolved.kind === 'task') {
    return resolved.workflowId;
  }
  const renderedTarget = resolved.target || String(targetArg ?? '');
  throw new Error(`Could not resolve headless target workflow for "${renderedTarget}"`);
}

export function isHeadlessReadOnlyCommand(args: string[]): boolean {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') return true;
  if (command === 'query') return true;
  return ['list', 'status', 'task-status', 'queue', 'audit', 'session', 'query-select', 'open-terminal', 'slack', 'watch'].includes(command);
}

export function isHeadlessMutatingCommand(args: string[]): boolean {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') return false;
  if (command === 'query') return false;

  if (command === 'set') {
    const sub = args[1];
    return ['command', 'executor', 'agent', 'merge-mode', 'gate-policy'].includes(sub ?? '');
  }

  if (['list', 'status', 'task-status', 'queue', 'audit', 'session', 'query-select', 'watch'].includes(command)) {
    return false;
  }

  if (['open-terminal'].includes(command)) {
    return false;
  }

  return [
    'run', 'resume', 'retry', 'retry-task', 'recreate', 'recreate-task', 'rebase', 'fix', 'resolve-conflict',
    'migrate-compat',
    'rebase-and-retry',
    'approve', 'reject', 'input', 'select',
    'cancel', 'cancel-workflow',
    'delete', 'delete-workflow', 'delete-all',
    'edit', 'edit-executor', 'edit-type', 'edit-agent', 'set-merge-mode',
  ].includes(command);
}
