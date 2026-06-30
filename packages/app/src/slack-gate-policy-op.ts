import type { ExternalDependency, ExternalGatePolicyUpdate, TaskState } from '@invoker/workflow-core';

export type SlackGatePolicy = 'completed' | 'review_ready';

export interface SlackGatePolicyUpdate {
  workflowId: string;
  taskId?: string;
  gatePolicy: SlackGatePolicy;
}

export interface SlackGatePolicyOp {
  operation: 'gate-policy';
  target: { all: true } | { workflow: string };
  updates: SlackGatePolicyUpdate[];
}

export interface SlackGatePolicyWorkflow {
  id: string;
  name?: string;
  externalDependencies?: ExternalDependency[];
}

export interface SlackGatePolicyPersistence {
  listWorkflows(): SlackGatePolicyWorkflow[];
  loadWorkflow(workflowId: string): SlackGatePolicyWorkflow | undefined;
}

export interface SlackGatePolicyMutations {
  setWorkflowExternalGatePolicies(
    workflowId: string,
    updates: ExternalGatePolicyUpdate[],
  ): Promise<{ runnable: TaskState[] } | { started?: TaskState[] } | { data?: TaskState[] } | unknown>;
}

export interface SlackGatePolicyOpDeps {
  persistence: SlackGatePolicyPersistence;
  mutations: SlackGatePolicyMutations;
}

export interface SlackGatePolicyOpResult {
  ok: boolean;
  summary: string;
}

function dependencyKey(workflowId: string, taskId?: string): string {
  return `${workflowId}::${taskId?.trim() || '__merge__'}`;
}

function workflowLabel(workflow: SlackGatePolicyWorkflow): string {
  return workflow.name ? `${workflow.id} (${workflow.name})` : workflow.id;
}

function resolveWorkflowId(input: string, workflows: SlackGatePolicyWorkflow[]): string | undefined {
  return workflows.find((workflow) => workflow.id === input || workflow.name === input)?.id;
}

function countStarted(result: Awaited<ReturnType<SlackGatePolicyMutations['setWorkflowExternalGatePolicies']>>): number {
  if (result && typeof result === 'object') {
    const value = result as { runnable?: unknown; started?: unknown; data?: unknown };
    if (Array.isArray(value.runnable)) return value.runnable.length;
    if (Array.isArray(value.started)) return value.started.length;
    if (Array.isArray(value.data)) return value.data.length;
  }
  return 0;
}

export async function executeSlackGatePolicyOp(
  op: SlackGatePolicyOp,
  deps: SlackGatePolicyOpDeps,
): Promise<SlackGatePolicyOpResult> {
  if (op.updates.length === 0) {
    return { ok: false, summary: 'No gate-policy updates provided.' };
  }

  const workflows = deps.persistence.listWorkflows();
  const targets = 'all' in op.target
    ? workflows
    : (() => {
        const workflowId = resolveWorkflowId(op.target.workflow, workflows);
        if (!workflowId) return undefined;
        const workflow = deps.persistence.loadWorkflow(workflowId) ?? workflows.find((candidate) => candidate.id === workflowId);
        return workflow ? [workflow] : undefined;
      })();

  if (!targets) return { ok: false, summary: `No workflow matching \`${op.target.workflow}\`.` };
  if (targets.length === 0) return { ok: false, summary: 'No workflows found.' };

  const normalizedUpdates: ExternalGatePolicyUpdate[] = [];
  for (const update of op.updates) {
    const workflowId = resolveWorkflowId(update.workflowId, workflows);
    if (!workflowId) {
      return { ok: false, summary: `No upstream workflow matching \`${update.workflowId}\`.` };
    }
    normalizedUpdates.push({ ...update, workflowId });
  }

  let ok = 0;
  let started = 0;
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const target of targets) {
    const workflow = deps.persistence.loadWorkflow(target.id) ?? target;
    const depsByKey = new Set(
      (workflow.externalDependencies ?? []).map((dep) => dependencyKey(dep.workflowId, dep.taskId)),
    );
    const applicable = normalizedUpdates.filter((update) => depsByKey.has(dependencyKey(update.workflowId, update.taskId)));
    if (applicable.length === 0) {
      skipped.push(workflowLabel(workflow));
      continue;
    }

    try {
      const result = await deps.mutations.setWorkflowExternalGatePolicies(workflow.id, applicable);
      ok++;
      started += countStarted(result);
    } catch (err) {
      failed.push(`${workflowLabel(workflow)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const parts = [`gate-policy: ${ok} updated`];
  if (started > 0) parts.push(`${started} task(s) started`);
  if (skipped.length > 0) parts.push(`${skipped.length} skipped without matching dependency`);
  if (failed.length > 0) parts.push(`${failed.length} failed\n${failed.join('\n')}`);

  return { ok: failed.length === 0 && ok > 0, summary: parts.join(', ') };
}
