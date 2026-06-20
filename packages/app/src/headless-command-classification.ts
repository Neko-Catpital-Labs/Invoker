/**
 * Shared classifier for headless CLI commands.
 *
 * This is used by both:
 * - main.ts (pre-init routing/delegation decisions)
 * - tests/policy checks to keep command routing behavior consistent
 */

import type { PersistenceAdapter } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import { findHeadlessCommandDefinition, isMutatingSetSubcommand } from './headless-command-registry.js';

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
  if (command === 'worker') {
    return args[1] !== 'autofix';
  }
  return findHeadlessCommandDefinition(command)?.kind === 'read';
}

export function isHeadlessMutatingCommand(args: string[]): boolean {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') return false;

  if (command === 'set') {
    return isMutatingSetSubcommand(args[1]);
  }

  if (command === 'worker') {
    return args[1] === 'autofix';
  }

  return findHeadlessCommandDefinition(command)?.kind === 'write';
}
