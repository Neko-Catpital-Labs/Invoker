import type { ExternalGatePolicyUpdate } from '@invoker/workflow-core';

type SlackWorkflowControlOpName =
  | 'recreate'
  | 'rebase-recreate'
  | 'rebase-retry'
  | 'retry'
  | 'status'
  | 'cancel';

type SlackWorkflowOpTarget = { all: true } | { workflow: string };

interface SlackWorkflowControlOp {
  operation: SlackWorkflowControlOpName;
  target: SlackWorkflowOpTarget;
}

interface SlackWorkflowGatePolicyOp {
  operation: 'gate-policy';
  target: SlackWorkflowOpTarget;
  ownerTaskId?: string;
  updates: ExternalGatePolicyUpdate[];
}

export type SlackWorkflowOp = SlackWorkflowControlOp | SlackWorkflowGatePolicyOp;

export interface SlackWorkflowOpProgress {
  done: number;
  total: number;
  ok: number;
  failed: number;
  current?: string;
}

export interface SlackWorkflowOpResult {
  ok: boolean;
  summary: string;
}

interface WorkflowSummary {
  id: string;
  name?: string;
  externalDependencies?: ExternalDependencySummary[];
}

interface ExternalDependencySummary {
  workflowId: string;
  taskId?: string;
  gatePolicy?: 'completed' | 'review_ready';
}

interface MutationResult {
  runnable?: unknown[];
}

interface SlackWorkflowOpMutations {
  recreateWorkflow(workflowId: string): Promise<unknown>;
  rebaseRecreate(workflowId: string): Promise<unknown>;
  rebaseRetry(workflowId: string): Promise<unknown>;
  retryWorkflow(workflowId: string): Promise<unknown>;
  cancelWorkflow(workflowId: string): Promise<unknown>;
  setWorkflowExternalGatePolicies(workflowId: string, updates: ExternalGatePolicyUpdate[]): Promise<MutationResult>;
}

export interface SlackWorkflowOpRunnerDeps {
  persistence: {
    listWorkflows(): WorkflowSummary[];
    loadWorkflow?(workflowId: string): WorkflowSummary | undefined;
  };
  orchestrator: {
    getWorkflowStatus(workflowId?: string): { running: number; pending: number; completed: number; failed: number };
  };
  mutations: SlackWorkflowOpMutations;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function workflowLabel(workflow: Pick<WorkflowSummary, 'id' | 'name'>): string {
  return workflow.name && workflow.name !== workflow.id ? `${workflow.id} (${workflow.name})` : workflow.id;
}

function depKey(workflowId: string, taskId?: string): string {
  return `${workflowId}::${taskId?.trim() || '__merge__'}`;
}

function defaultGatePolicy(taskId?: string): 'completed' | 'review_ready' {
  return (taskId?.trim() || '__merge__') === '__merge__' ? 'completed' : 'review_ready';
}

function resolveTargetWorkflows(
  op: SlackWorkflowOp,
  workflows: WorkflowSummary[],
): WorkflowSummary[] | string {
  if ('all' in op.target) return workflows;
  const wanted = op.target.workflow;
  const match = workflows.find((w) => w.id === wanted || w.name === wanted);
  return match ? [match] : `No workflow matching \`${wanted}\`.`;
}

function loadWorkflow(
  deps: SlackWorkflowOpRunnerDeps,
  listed: WorkflowSummary,
): WorkflowSummary | undefined {
  return deps.persistence.loadWorkflow?.(listed.id) ?? listed;
}

function matchingGatePolicyUpdates(
  workflow: WorkflowSummary,
  requested: ExternalGatePolicyUpdate[],
): { updates: ExternalGatePolicyUpdate[]; unchanged: number; matched: number } {
  const deps = workflow.externalDependencies ?? [];
  const byKey = new Map<string, ExternalGatePolicyUpdate>();
  let unchanged = 0;
  let matched = 0;

  for (const request of requested) {
    for (const dep of deps) {
      if (depKey(dep.workflowId, dep.taskId) !== depKey(request.workflowId, request.taskId)) continue;
      matched++;
      if ((dep.gatePolicy ?? defaultGatePolicy(dep.taskId)) === request.gatePolicy) {
        unchanged++;
        continue;
      }
      byKey.set(depKey(dep.workflowId, dep.taskId), {
        workflowId: dep.workflowId,
        ...(dep.taskId === undefined ? {} : { taskId: dep.taskId }),
        gatePolicy: request.gatePolicy,
      });
    }
  }

  return { updates: [...byKey.values()], unchanged, matched };
}

async function runGatePolicyOp(
  op: Extract<SlackWorkflowOp, { operation: 'gate-policy' }>,
  workflowTargets: WorkflowSummary[],
  deps: SlackWorkflowOpRunnerDeps,
  onProgress?: (p: SlackWorkflowOpProgress) => void,
): Promise<SlackWorkflowOpResult> {
  if (op.updates.length === 0) {
    return { ok: false, summary: 'No gate-policy updates provided.' };
  }

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let tasksStarted = 0;
  const failed: string[] = [];
  const total = workflowTargets.length;

  for (const [index, target] of workflowTargets.entries()) {
    onProgress?.({ done: index, total, ok: updated, failed: failed.length, current: target.id });
    const workflow = loadWorkflow(deps, target);
    if (!workflow) {
      failed.push(`${target.id}: workflow not found`);
      continue;
    }
    const match = matchingGatePolicyUpdates(workflow, op.updates);
    unchanged += match.unchanged;
    if (match.updates.length === 0) {
      skipped++;
      continue;
    }

    try {
      const result = await deps.mutations.setWorkflowExternalGatePolicies(workflow.id, match.updates);
      tasksStarted += result.runnable?.length ?? 0;
      updated++;
    } catch (err) {
      failed.push(`${workflowLabel(workflow)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onProgress?.({ done: total, total, ok: updated, failed: failed.length });

  const summary = [
    `gate-policy: ${plural(updated, 'workflow')} updated`,
    `${plural(unchanged, 'dependency')} already matched`,
    `${plural(skipped, 'workflow')} skipped`,
    `${plural(tasksStarted, 'task')} started`,
  ].join(', ');
  return {
    ok: failed.length === 0 && (updated > 0 || unchanged > 0),
    summary: failed.length ? `${summary}\n${failed.length} failed\n${failed.join('\n')}` : summary,
  };
}

export function createSlackWorkflowOpRunner(deps: SlackWorkflowOpRunnerDeps) {
  return async (
    op: SlackWorkflowOp,
    onProgress?: (p: SlackWorkflowOpProgress) => void,
  ): Promise<SlackWorkflowOpResult> => {
    const workflows = deps.persistence.listWorkflows();
    const workflowTargets = resolveTargetWorkflows(op, workflows);
    if (typeof workflowTargets === 'string') return { ok: false, summary: workflowTargets };
    if (workflowTargets.length === 0) return { ok: false, summary: 'No workflows found.' };

    if (op.operation === 'status') {
      const lines = workflowTargets.map((t) => {
        const s = deps.orchestrator.getWorkflowStatus(t.id);
        return `\`${t.id}\`: ${s.running} running, ${s.pending} pending, ${s.completed} done, ${s.failed} failed`;
      });
      return { ok: true, summary: lines.join('\n') };
    }

    if (op.operation === 'gate-policy') {
      return runGatePolicyOp(op, workflowTargets, deps, onProgress);
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
    for (const t of workflowTargets) {
      onProgress?.({ done: ok + failed.length, total, ok, failed: failed.length, current: t.id });
      try {
        await run(t.id);
        ok++;
      } catch (err) {
        failed.push(`${t.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    onProgress?.({ done: total, total, ok, failed: failed.length });
    const summary = `${op.operation}: ${ok} ok${failed.length ? `, ${failed.length} failed\n${failed.join('\n')}` : ''}`;
    return { ok: failed.length === 0, summary };
  };
}
