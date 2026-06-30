/**
 * runWorkflowOp seam — executes lobby workflow operations against a running
 * Invoker over IPC, mirroring the in-process `wireSlackBot.runWorkflowOp`.
 *
 * Reads resolve targets via `headless.query`; mutations delegate via
 * `headless.exec` so the owner serializes them (no forced-standalone writes).
 * When Invoker is down, `withRecovery` relaunches and retries once; if it's
 * still down, a failure result is returned for the surface to post.
 */

import type { WorkflowOp, WorkflowOpName, WorkflowOpProgress, WorkflowOpResult } from '@invoker/surfaces';
import { InvokerDownError, type InvokerClient } from './invoker-client.js';
import { errMessage } from './util.js';

export type RunWorkflowOp = (
  op: WorkflowOp,
  onProgress?: (p: WorkflowOpProgress) => void,
) => Promise<WorkflowOpResult>;

const DOWN_SUMMARY = 'Invoker is down and I could not bring it back. Reply `restart` to retry.';

/** Workflow-op verb → delegated headless `exec` command (workflow id appended). `cancel` is workflow-scoped. */
const MUTATION_COMMAND: Partial<Record<WorkflowOpName, string>> = {
  recreate: 'recreate',
  'rebase-recreate': 'rebase-recreate',
  'rebase-retry': 'rebase-retry',
  retry: 'retry',
  cancel: 'cancel-workflow',
};

export function createRunWorkflowOp(
  client: InvokerClient,
  log: (level: string, message: string) => void,
): RunWorkflowOp {
  return async (op, onProgress) => {
    try {
      return await client.withRecovery(() => runOnce(client, op, onProgress));
    } catch (err) {
      if (err instanceof InvokerDownError) return { ok: false, summary: DOWN_SUMMARY };
      log('error', `workflow op ${op.operation} failed: ${errMessage(err)}`);
      return { ok: false, summary: `Operation failed: ${errMessage(err)}` };
    }
  };
}

async function runOnce(
  client: InvokerClient,
  op: WorkflowOp,
  onProgress?: (p: WorkflowOpProgress) => void,
): Promise<WorkflowOpResult> {
  const all = await client.listWorkflows();
  let ids: string[];
  if ('all' in op.target) {
    ids = all.map((w) => w.id);
  } else {
    const wanted = op.target.workflow;
    const match = all.find((w) => w.id === wanted || w.name === wanted);
    if (!match) return { ok: false, summary: `No workflow matching \`${wanted}\`.` };
    ids = [match.id];
  }
  if (ids.length === 0) return { ok: false, summary: 'No workflows found.' };

  if (op.operation === 'gate-policy') {
    return runGatePolicy(client, op, all, ids, onProgress);
  }

  if (op.operation === 'status') {
    const lines = await Promise.all(ids.map(async (id) => {
      const s = await client.getWorkflowStatus(id);
      return `\`${id}\`: ${s.running} running, ${s.pending} pending, ${s.completed} done, ${s.failed} failed`;
    }));
    return { ok: true, summary: lines.join('\n') };
  }

  const command = MUTATION_COMMAND[op.operation];
  if (!command) return { ok: false, summary: `Unsupported operation \`${op.operation}\`.` };

  let ok = 0;
  const failed: string[] = [];
  const total = ids.length;
  for (const id of ids) {
    onProgress?.({ done: ok + failed.length, total, ok, failed: failed.length, current: id });
    try {
      await client.exec([command, id]);
      ok++;
    } catch (err) {
      if (err instanceof InvokerDownError) throw err; // bubble to withRecovery
      failed.push(`${id}: ${errMessage(err)}`);
    }
  }
  onProgress?.({ done: total, total, ok, failed: failed.length });
  const summary = `${op.operation}: ${ok} ok${failed.length ? `, ${failed.length} failed\n${failed.join('\n')}` : ''}`;
  return { ok: failed.length === 0, summary };
}

async function runGatePolicy(
  client: InvokerClient,
  op: Extract<WorkflowOp, { operation: 'gate-policy' }>,
  all: Awaited<ReturnType<InvokerClient['listWorkflows']>>,
  ids: string[],
  onProgress?: (p: WorkflowOpProgress) => void,
): Promise<WorkflowOpResult> {
  const normalized: typeof op.updates = [];
  for (const update of op.updates) {
    const upstream = all.find((w) => w.id === update.workflowId || w.name === update.workflowId);
    if (!upstream) return { ok: false, summary: `No upstream workflow matching \`${update.workflowId}\`.` };
    normalized.push({ ...update, workflowId: upstream.id });
  }

  let ok = 0;
  let changed = 0;
  const skipped: string[] = [];
  const failed: string[] = [];
  const total = ids.length;

  for (const id of ids) {
    onProgress?.({ done: ok + skipped.length + failed.length, total, ok, failed: failed.length, current: id });
    try {
      const bundle = await client.getWorkflowBundle(id);
      const deps = bundle.workflow?.externalDependencies ?? [];
      const applicable = normalized.filter((update) => deps.some((dep) => (
        dep.workflowId === update.workflowId && (dep.taskId ?? '__merge__') === (update.taskId ?? '__merge__')
      )));
      if (applicable.length === 0) {
        skipped.push(id);
        continue;
      }
      for (const update of applicable) {
        const args = ['set', 'workflow-gate-policy', id, update.workflowId];
        if (update.taskId) args.push(update.taskId);
        args.push(update.gatePolicy);
        await client.exec(args);
      }
      ok++;
      changed += applicable.length;
    } catch (err) {
      if (err instanceof InvokerDownError) throw err;
      failed.push(`${id}: ${errMessage(err)}`);
    }
  }

  onProgress?.({ done: total, total, ok, failed: failed.length });
  const summary = `gate-policy: ${ok} updated${changed ? `, ${changed} change(s)` : ''}${skipped.length ? `, ${skipped.length} skipped without matching dependency` : ''}${failed.length ? `, ${failed.length} failed\n${failed.join('\n')}` : ''}`;
  return { ok: failed.length === 0 && ok > 0, summary };
}
