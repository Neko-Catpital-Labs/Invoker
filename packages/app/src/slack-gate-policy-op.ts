import type { ExternalDependency, ExternalGatePolicyUpdate } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';

type SlackWorkflowOpName =
  | 'recreate'
  | 'rebase-recreate'
  | 'rebase-retry'
  | 'retry'
  | 'status'
  | 'cancel';

type SlackWorkflowOpTarget = { all: true } | { workflow: string };

export type SlackWorkflowOp =
  | { operation: SlackWorkflowOpName; target: SlackWorkflowOpTarget }
  | { operation: 'gate-policy'; target: SlackWorkflowOpTarget; ownerTaskId?: string; updates: ExternalGatePolicyUpdate[] };

export interface SlackWorkflowOpResult {
  ok: boolean;
  summary: string;
}

export interface SlackWorkflowOpProgress {
  done: number;
  total: number;
  ok: number;
  failed: number;
  current?: string;
}

interface SlackWorkflowMutations {
  recreateWorkflow: (workflowId: string) => Promise<unknown>;
  rebaseRecreate: (workflowId: string) => Promise<unknown>;
  rebaseRetry: (workflowId: string) => Promise<unknown>;
  retryWorkflow: (workflowId: string) => Promise<unknown>;
  cancelWorkflow: (workflowId: string) => Promise<unknown>;
  setWorkflowExternalGatePolicies: (
    workflowId: string,
    updates: ExternalGatePolicyUpdate[],
  ) => Promise<{ runnable: unknown[] }>;
}

export interface SlackWorkflowOpRunnerDeps {
  persistence: Pick<SQLiteAdapter, 'listWorkflows' | 'loadWorkflow'>;
  orchestrator: { getWorkflowStatus: (workflowId?: string) => { running: number; pending: number; completed: number; failed: number } };
  mutations: SlackWorkflowMutations;
}

interface ResolvedWorkflow {
  id: string;
  name?: string;
}

function dependencyTaskKey(taskId?: string): string {
  return taskId?.trim() || '__merge__';
}

function dependencyLabel(update: ExternalGatePolicyUpdate): string {
  return `${update.workflowId}/${dependencyTaskKey(update.taskId)} -> ${update.gatePolicy}`;
}

function dedupeUpdates(updates: ExternalGatePolicyUpdate[]): ExternalGatePolicyUpdate[] {
  const byKey = new Map<string, ExternalGatePolicyUpdate>();
  for (const update of updates) {
    byKey.set(`${update.workflowId}::${dependencyTaskKey(update.taskId)}`, update);
  }
  return [...byKey.values()];
}

function resolveWorkflowTargets(
  persistence: SlackWorkflowOpRunnerDeps['persistence'],
  target: SlackWorkflowOpTarget,
): ResolvedWorkflow[] | string {
  const workflows = persistence.listWorkflows();
  if ('all' in target) return workflows.map((workflow) => ({ id: workflow.id, name: workflow.name }));

  const wanted = target.workflow;
  const match = workflows.find((workflow) => workflow.id === wanted || workflow.name === wanted);
  if (!match) return `No workflow matching \`${wanted}\`.`;
  return [{ id: match.id, name: match.name }];
}

function dependencyMatchesUpdate(dep: ExternalDependency, update: ExternalGatePolicyUpdate): boolean {
  if (dep.workflowId !== update.workflowId) return false;
  if (update.taskId === undefined) return true;
  return dependencyTaskKey(dep.taskId) === dependencyTaskKey(update.taskId);
}

function buildGatePolicyUpdatesForWorkflow(
  deps: ExternalDependency[],
  requestedUpdates: ExternalGatePolicyUpdate[],
): ExternalGatePolicyUpdate[] {
  const updates: ExternalGatePolicyUpdate[] = [];
  for (const requested of requestedUpdates) {
    for (const dep of deps) {
      if (!dependencyMatchesUpdate(dep, requested)) continue;
      updates.push({
        workflowId: dep.workflowId,
        taskId: dep.taskId,
        gatePolicy: requested.gatePolicy,
      });
    }
  }
  return dedupeUpdates(updates);
}

export function createSlackWorkflowOpRunner(
  deps: SlackWorkflowOpRunnerDeps,
): (op: SlackWorkflowOp, onProgress?: (p: SlackWorkflowOpProgress) => void) => Promise<SlackWorkflowOpResult> {
  return async (op, onProgress) => {
    const workflowTargets = resolveWorkflowTargets(deps.persistence, op.target);
    if (typeof workflowTargets === 'string') return { ok: false, summary: workflowTargets };
    if (workflowTargets.length === 0) return { ok: false, summary: 'No workflows found.' };

    if (op.operation === 'status') {
      const lines = workflowTargets.map((target) => {
        const s = deps.orchestrator.getWorkflowStatus(target.id);
        return `\`${target.id}\`: ${s.running} running, ${s.pending} pending, ${s.completed} done, ${s.failed} failed`;
      });
      return { ok: true, summary: lines.join('\n') };
    }

    if (op.operation === 'gate-policy') {
      return runGatePolicyOp(deps, workflowTargets, op.updates, onProgress);
    }

    const mutate: Record<string, (id: string) => Promise<unknown>> = {
      recreate: (id) => deps.mutations.recreateWorkflow(id),
      'rebase-recreate': (id) => deps.mutations.rebaseRecreate(id),
      'rebase-retry': (id) => deps.mutations.rebaseRetry(id),
      retry: (id) => deps.mutations.retryWorkflow(id),
      cancel: (id) => deps.mutations.cancelWorkflow(id),
    };
    const run = mutate[op.operation];
    if (!run) return { ok: false, summary: `Unsupported operation \`${op.operation}\`.` };

    let ok = 0;
    const failed: string[] = [];
    const total = workflowTargets.length;
    for (const target of workflowTargets) {
      onProgress?.({ done: ok + failed.length, total, ok, failed: failed.length, current: target.id });
      try {
        await run(target.id);
        ok++;
      } catch (err) {
        failed.push(`${target.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    onProgress?.({ done: total, total, ok, failed: failed.length });
    const summary = `${op.operation}: ${ok} ok${failed.length ? `, ${failed.length} failed\n${failed.join('\n')}` : ''}`;
    return { ok: failed.length === 0, summary };
  };
}

async function runGatePolicyOp(
  deps: SlackWorkflowOpRunnerDeps,
  workflowTargets: ResolvedWorkflow[],
  requestedUpdates: ExternalGatePolicyUpdate[],
  onProgress?: (p: SlackWorkflowOpProgress) => void,
): Promise<SlackWorkflowOpResult> {
  if (requestedUpdates.length === 0) {
    return { ok: false, summary: 'gate-policy: no updates requested.' };
  }

  let ok = 0;
  let tasksStarted = 0;
  const changed: string[] = [];
  const failed: string[] = [];
  const total = workflowTargets.length;

  for (const target of workflowTargets) {
    onProgress?.({ done: ok + failed.length, total, ok, failed: failed.length, current: target.id });
    try {
      const workflow = deps.persistence.loadWorkflow(target.id);
      const externalDeps = workflow?.externalDependencies ?? [];
      if (externalDeps.length === 0) {
        throw new Error(`Workflow ${target.id} has no external dependencies`);
      }

      const updates = buildGatePolicyUpdatesForWorkflow(externalDeps, requestedUpdates);
      if (updates.length === 0) {
        throw new Error(
          `Workflow ${target.id} has no external dependencies matching ${requestedUpdates.map(dependencyLabel).join(', ')}`,
        );
      }

      const result = await deps.mutations.setWorkflowExternalGatePolicies(target.id, updates);
      tasksStarted += result.runnable.length;
      changed.push(`${target.id}: ${updates.map(dependencyLabel).join(', ')}`);
      ok++;
    } catch (err) {
      failed.push(`${target.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onProgress?.({ done: total, total, ok, failed: failed.length });
  const summary = [
    `gate-policy: ${ok} ok${failed.length ? `, ${failed.length} failed` : ''}, ${tasksStarted} task(s) started`,
    ...changed,
    ...failed,
  ].join('\n');
  return { ok: failed.length === 0, summary };
}
