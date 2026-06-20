/**
 * HTTP API Server — Lightweight control plane for a running Invoker instance.
 *
 * Binds to 127.0.0.1 only (no external access). Default port 4100,
 * configurable via INVOKER_API_PORT env var.
 *
 * All write endpoints delegate to a WorkflowMutationFacade instance
 * which encapsulates the mutation → dispatch → topup lifecycle.
 *
 * Read endpoints:
 *   GET  /api/health
 *   GET  /api/status
 *   GET  /api/tasks                ?status=running
 *   GET  /api/tasks/:id
 *   GET  /api/tasks/:id/events     Audit event log
 *   GET  /api/tasks/:id/output     Captured stdout/stderr
 *   GET  /api/workflows            List all workflows
 *   GET  /api/queue                Scheduler queue status
 *
 * Write endpoints:
 *   POST   /api/tasks/:id/cancel
 *   POST   /api/tasks/:id/restart
 *   POST   /api/tasks/:id/recreate-downstream
 *   POST   /api/tasks/:id/resolve-conflict  body: { agent? }
 *   POST   /api/tasks/:id/approve
 *   POST   /api/tasks/:id/reject       body: { reason? }
 *   POST   /api/tasks/:id/input        body: { text }
 *   POST   /api/tasks/:id/edit         body: { command }
 *   POST   /api/tasks/:id/edit-prompt  body: { prompt }
 *   POST   /api/tasks/:id/edit-type    body: { runnerKind, poolMemberId? }
 *   POST   /api/tasks/:id/edit-agent   body: { agent }
 *   POST   /api/tasks/:id/gate-policy  body: { updates: [{ workflowId, taskId?, gatePolicy }] }
 *   POST   /api/workflows/:id/detach  body: { upstreamWorkflowId }
 *   POST   /api/workflows/:id/restart
 *   POST   /api/workflows/:id/rebase-retry
 *   POST   /api/workflows/:id/rebase-recreate
 *   POST   /api/workflows/:id/cancel
 *   POST   /api/workflows/:id/merge-mode  body: { mode }
 *   DELETE /api/workflows/:id
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Logger } from '@invoker/contracts';
import {
  OrchestratorError,
  OrchestratorErrorCode,
  PlanConflictError,
  TopologyForkRequired,
} from '@invoker/workflow-core';
import type { ExternalGatePolicyUpdate, Orchestrator } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { ExecutorRegistry } from '@invoker/execution-engine';
import type {
  ApproveMutationResult,
  CancelMutationResult,
  ForkMutationResult,
  MutationResult,
  ResolveConflictMutationResult,
} from './workflow-mutation-facade.js';
import { resolveHeadlessTargetWorkflowId } from './headless-command-classification.js';
import type { WorkflowMutationPriority } from './workflow-mutation-coordinator.js';
import { parseMetadataPatchBody, type MetadataSetResult } from './metadata-setter.js';

export interface ApiMutationFacade {
  cancelTask(taskId: string): Promise<CancelMutationResult>;
  retryTask(taskId: string): Promise<MutationResult>;
  recreateTask(taskId: string): Promise<MutationResult>;
  recreateDownstream(taskId: string): Promise<MutationResult>;
  resolveConflict(taskId: string, agentName?: string): Promise<ResolveConflictMutationResult>;
  approveTask(taskId: string): Promise<ApproveMutationResult>;
  rejectTask(taskId: string, reason?: string): void;
  provideInput(taskId: string, text: string): void;
  editTaskCommand(taskId: string, newCommand: string): Promise<MutationResult>;
  editTaskPrompt(taskId: string, newPrompt: string): Promise<MutationResult>;
  editTaskType(taskId: string, runnerKind: string, poolMemberId?: string): Promise<MutationResult>;
  editTaskAgent(taskId: string, agentName: string): Promise<MutationResult>;
  setTaskExternalGatePolicies(
    taskId: string,
    updates: ExternalGatePolicyUpdate[],
  ): Promise<MutationResult>;
  setWorkflowExternalGatePolicies(
    workflowId: string,
    updates: ExternalGatePolicyUpdate[],
  ): Promise<MutationResult>;
  setTaskMetadata(
    taskId: string,
    fieldPath: string,
    value: unknown,
    options?: { raw?: boolean },
  ): Promise<MetadataSetResult>;
  recreateWorkflow(workflowId: string): Promise<MutationResult>;
  retryWorkflow(workflowId: string): Promise<MutationResult>;
  rebaseRetry(target: string): Promise<MutationResult>;
  rebaseRecreate(target: string): Promise<MutationResult>;
  forkWorkflow(workflowId: string): Promise<ForkMutationResult>;
  cancelWorkflow(workflowId: string): Promise<CancelMutationResult>;
  setWorkflowMergeMode(workflowId: string, mergeMode: string): Promise<void>;
  setWorkflowMetadata(
    workflowId: string,
    fieldPath: string,
    value: unknown,
    options?: { raw?: boolean },
  ): Promise<MetadataSetResult>;
}

export interface ApiServerDeps {
  logger?: Logger;
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  executorRegistry: ExecutorRegistry;
  /** All write endpoints delegate to the facade for mutation + dispatch + topup. */
  mutations: ApiMutationFacade;
  queueWorkflowMutation?: (
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ) => number;
  deleteWorkflow: (workflowId: string) => Promise<void>;
  detachWorkflow: (workflowId: string, upstreamWorkflowId: string) => Promise<void>;
}

export interface ApiServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function parseRoute(url: string): { path: string; query: Record<string, string> } {
  const idx = url.indexOf('?');
  const path = idx === -1 ? url : url.slice(0, idx);
  const query: Record<string, string> = {};
  if (idx !== -1) {
    for (const part of url.slice(idx + 1).split('&')) {
      const [k, v] = part.split('=');
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
    }
  }
  return { path, query };
}

function serializeTask(task: any): any {
  const obj: any = { ...task };
  if (obj.createdAt instanceof Date) obj.createdAt = obj.createdAt.toISOString();
  if (obj.execution) {
    obj.execution = { ...obj.execution };
    for (const key of [
      'startedAt',
      'completedAt',
      'lastHeartbeatAt',
      'launchStartedAt',
      'launchCompletedAt',
    ]) {
      if (obj.execution[key] instanceof Date) obj.execution[key] = obj.execution[key].toISOString();
    }
  }
  if (task.execution?.lastHeartbeatAt) {
    const hb = task.execution.lastHeartbeatAt instanceof Date
      ? task.execution.lastHeartbeatAt
      : new Date(task.execution.lastHeartbeatAt);
    obj.secondsSinceHeartbeat = Math.round((Date.now() - hb.getTime()) / 1000);
  }
  return obj;
}

/** Map domain errors to HTTP status codes. Falls back to 400. */
const notFoundCodes: ReadonlySet<string> = new Set([
  OrchestratorErrorCode.TASK_NOT_FOUND,
  OrchestratorErrorCode.WORKFLOW_NOT_FOUND,
]);

const conflictCodes: ReadonlySet<string> = new Set([
  OrchestratorErrorCode.TASK_ALREADY_TERMINAL,
]);

function httpStatusForError(err: unknown): number {
  if (err instanceof OrchestratorError) {
    if (notFoundCodes.has(err.code)) return 404;
    if (conflictCodes.has(err.code)) return 409;
  }
  if (err instanceof PlanConflictError) return 409;
  if (err instanceof TopologyForkRequired) return 409;
  return 400;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function startApiServer(deps: ApiServerDeps): ApiServer {
  const {
    logger: apiLogger,
    orchestrator,
    persistence,
    mutations,
    deleteWorkflow,
    detachWorkflow,
  } = deps;
  const port = parseInt(process.env.INVOKER_API_PORT ?? '4100', 10);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method ?? 'GET';
      const { path, query } = parseRoute(req.url ?? '/');

      // GET /api/health
      if (method === 'GET' && path === '/api/health') {
        json(res, 200, { ok: true, uptime: process.uptime() });
        return;
      }

      // GET /api/status
      if (method === 'GET' && path === '/api/status') {
        const status = orchestrator.getWorkflowStatus();
        json(res, 200, status);
        return;
      }

      // GET /api/tasks
      if (method === 'GET' && path === '/api/tasks') {
        let tasks = orchestrator.getAllTasks();
        if (query.status) {
          tasks = tasks.filter((t) => t.status === query.status);
        }
        json(res, 200, tasks.map(serializeTask));
        return;
      }

      // GET /api/tasks/:id
      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (method === 'GET' && taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1]);
        const task = orchestrator.getTask(taskId);
        if (!task) {
          json(res, 404, { error: `Task "${taskId}" not found` });
          return;
        }
        json(res, 200, serializeTask(task));
        return;
      }

      // POST /api/tasks/:id/cancel
      const cancelMatch = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
      if (method === 'POST' && cancelMatch) {
        const taskId = decodeURIComponent(cancelMatch[1]);
        try {
          const result = await mutations.cancelTask(taskId);
          json(res, 200, { ok: true, cancelled: result.cancelled, runningCancelled: result.runningCancelled });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/tasks/:id/retry  (legacy: /api/tasks/:id/restart)
      const retryMatch = path.match(/^\/api\/tasks\/([^/]+)\/retry$/);
      const restartMatch = path.match(/^\/api\/tasks\/([^/]+)\/restart$/);
      if (method === 'POST' && (retryMatch || restartMatch)) {
        const isLegacy = !!restartMatch;
        const taskId = decodeURIComponent((retryMatch ?? restartMatch)![1]);
        try {
          const result = await mutations.retryTask(taskId);
          if (isLegacy) {
            res.setHeader(
              'Deprecation',
              'true; reason="Use /api/tasks/:id/retry or /api/tasks/:id/recreate"',
            );
          }
          json(res, 200, {
            ok: true,
            taskId,
            action: isLegacy ? 'restarted' : 'retried',
            tasksStarted: result.runnable.length,
            ...(isLegacy ? { deprecated: true, replacement: '/api/tasks/:id/retry' } : {}),
          });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/tasks/:id/recreate
      const recreateTaskMatch = path.match(/^\/api\/tasks\/([^/]+)\/recreate$/);
      if (method === 'POST' && recreateTaskMatch) {
        const taskId = decodeURIComponent(recreateTaskMatch[1]);
        try {
          const result = await mutations.recreateTask(taskId);
          json(res, 200, { ok: true, taskId, action: 'recreated', tasksStarted: result.runnable.length });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/tasks/:id/recreate-downstream
      const recreateDownstreamMatch = path.match(/^\/api\/tasks\/([^/]+)\/recreate-downstream$/);
      if (method === 'POST' && recreateDownstreamMatch) {
        const taskId = decodeURIComponent(recreateDownstreamMatch[1]);
        try {
          const result = await mutations.recreateDownstream(taskId);
          json(res, 200, { ok: true, taskId, action: 'recreated_downstream', tasksStarted: result.runnable.length });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/tasks/:id/resolve-conflict   body: { agent? }
      const resolveConflictMatch = path.match(/^\/api\/tasks\/([^/]+)\/resolve-conflict$/);
      if (method === 'POST' && resolveConflictMatch) {
        const taskId = decodeURIComponent(resolveConflictMatch[1]);
        try {
          let agent: string | undefined;
          const body = await readBody(req);
          if (body) {
            try {
              const parsed = JSON.parse(body);
              agent = parsed.agent;
            } catch { /* not JSON, ignore */ }
          }
          const result = await mutations.resolveConflict(taskId, agent);
          json(res, 200, {
            ok: true,
            taskId,
            action: 'resolve_conflict',
            status: result.autoApproved ? 'auto_approved' : 'awaiting_approval',
          });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/tasks/:id/approve
      const approveMatch = path.match(/^\/api\/tasks\/([^/]+)\/approve$/);
      if (method === 'POST' && approveMatch) {
        const taskId = decodeURIComponent(approveMatch[1]);
        try {
          await mutations.approveTask(taskId);
          json(res, 200, { ok: true, taskId, action: 'approved' });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/tasks/:id/reject
      const rejectMatch = path.match(/^\/api\/tasks\/([^/]+)\/reject$/);
      if (method === 'POST' && rejectMatch) {
        const taskId = decodeURIComponent(rejectMatch[1]);
        try {
          let reason: string | undefined;
          const body = await readBody(req);
          if (body) {
            try {
              const parsed = JSON.parse(body);
              reason = parsed.reason;
            } catch { /* not JSON, ignore */ }
          }
          mutations.rejectTask(taskId, reason);
          json(res, 200, { ok: true, taskId, action: 'rejected', reason });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // GET /api/workflows
      if (method === 'GET' && path === '/api/workflows') {
        const workflows = persistence.listWorkflows();
        json(res, 200, workflows);
        return;
      }

      // GET /api/search
      if (method === 'GET' && path === '/api/search') {
        const q = query.q || '';
        const type = query.type === 'workflows' || query.type === 'tasks' ? query.type : 'all';
        const limit = query.limit ? Math.min(parseInt(query.limit, 10), 50) : 20;
        const offset = query.offset ? parseInt(query.offset, 10) : 0;
        const results = persistence.searchWorkflowsAndTasks(q, { type, limit, offset });
        json(res, 200, results);
        return;
      }

      // POST /api/workflows/:id/recreate  (legacy: /api/workflows/:id/restart)
      const wfRecreateMatch = path.match(/^\/api\/workflows\/([^/]+)\/recreate$/);
      const wfRestartMatch = path.match(/^\/api\/workflows\/([^/]+)\/restart$/);
      if (method === 'POST' && (wfRecreateMatch || wfRestartMatch)) {
        const isLegacy = !!wfRestartMatch;
        const workflowId = decodeURIComponent((wfRecreateMatch ?? wfRestartMatch)![1]);
        try {
          const result = await mutations.recreateWorkflow(workflowId);
          if (isLegacy) {
            res.setHeader(
              'Deprecation',
              'true; reason="Use /api/workflows/:id/recreate"',
            );
          }
          const tasksStarted = result.runnable.length;
          json(res, 200, {
            ok: true,
            workflowId,
            action: isLegacy ? 'restarted' : 'recreated',
            tasksStarted,
            ...(isLegacy ? { deprecated: true, replacement: '/api/workflows/:id/recreate' } : {}),
          });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/workflows/:id/retry
      const wfRetryMatch = path.match(/^\/api\/workflows\/([^/]+)\/retry$/);
      if (method === 'POST' && wfRetryMatch) {
        const workflowId = decodeURIComponent(wfRetryMatch[1]);
        try {
          const result = await mutations.retryWorkflow(workflowId);
          const tasksStarted = result.runnable.length;
          json(res, 200, { ok: true, workflowId, action: 'retried', tasksStarted });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/workflows/:id/rebase-retry
      const wfRebaseRetryMatch = path.match(/^\/api\/workflows\/([^/]+)\/rebase-retry$/);
      if (method === 'POST' && wfRebaseRetryMatch) {
        const workflowTarget = decodeURIComponent(wfRebaseRetryMatch[1]);
        try {
          const workflowId = resolveHeadlessTargetWorkflowId(workflowTarget, persistence);
          const result = await mutations.rebaseRetry(workflowId);
          const tasksStarted = result.runnable.length;
          json(res, 200, {
            ok: true,
            workflowId,
            action: 'rebase_retried',
            tasksStarted,
          });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/workflows/:id/rebase-recreate
      const wfRebaseRecreateMatch = path.match(/^\/api\/workflows\/([^/]+)\/rebase-recreate$/);
      if (method === 'POST' && wfRebaseRecreateMatch) {
        const workflowTarget = decodeURIComponent(wfRebaseRecreateMatch[1]);
        try {
          const workflowId = resolveHeadlessTargetWorkflowId(workflowTarget, persistence);
          if (deps.queueWorkflowMutation) {
            const intentId = deps.queueWorkflowMutation(workflowId, 'high', 'invoker:rebase-recreate', [workflowId]);
            json(res, 202, {
              ok: true,
              workflowId,
              action: 'rebase_recreated',
              queued: true,
              intentId,
              tasksStarted: 0,
            });
            return;
          }
          const result = await mutations.rebaseRecreate(workflowId);
          const tasksStarted = result.runnable.length;
          json(res, 200, {
            ok: true,
            workflowId,
            action: 'rebase_recreated',
            tasksStarted,
          });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/workflows/:id/fork
      const wfForkMatch = path.match(/^\/api\/workflows\/([^/]+)\/fork$/);
      if (method === 'POST' && wfForkMatch) {
        const workflowId = decodeURIComponent(wfForkMatch[1]);
        try {
          const result = await mutations.forkWorkflow(workflowId);
          json(res, 200, {
            ok: true,
            sourceWorkflowId: result.sourceWorkflowId,
            forkedWorkflowId: result.forkedWorkflowId,
            tasksStarted: result.runnable.length,
          });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/workflows/:id/cancel
      const wfCancelMatch = path.match(/^\/api\/workflows\/([^/]+)\/cancel$/);
      if (method === 'POST' && wfCancelMatch) {
        const workflowId = decodeURIComponent(wfCancelMatch[1]);
        try {
          const result = await mutations.cancelWorkflow(workflowId);
          json(res, 200, { ok: true, cancelled: result.cancelled, runningCancelled: result.runningCancelled });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // GET /api/queue
      if (method === 'GET' && path === '/api/queue') {
        const queueStatus = orchestrator.getQueueStatus();
        json(res, 200, queueStatus);
        return;
      }

      // GET /api/tasks/:id/events
      const eventsMatch = path.match(/^\/api\/tasks\/([^/]+)\/events$/);
      if (method === 'GET' && eventsMatch) {
        const taskId = decodeURIComponent(eventsMatch[1]);
        const events = persistence.getEvents(taskId);
        json(res, 200, events);
        return;
      }

      // GET /api/tasks/:id/output
      const outputMatch = path.match(/^\/api\/tasks\/([^/]+)\/output$/);
      if (method === 'GET' && outputMatch) {
        const taskId = decodeURIComponent(outputMatch[1]);
        const output = persistence.getTaskOutput(taskId);
        json(res, 200, { taskId, output });
        return;
      }

      // POST /api/tasks/:id/input
      const inputMatch = path.match(/^\/api\/tasks\/([^/]+)\/input$/);
      if (method === 'POST' && inputMatch) {
        const taskId = decodeURIComponent(inputMatch[1]);
        try {
          const body = await readBody(req);
          const { text } = JSON.parse(body);
          if (!text) {
            json(res, 400, { error: 'Missing "text" in request body' });
            return;
          }
          mutations.provideInput(taskId, text);
          json(res, 200, { ok: true, taskId, action: 'input_provided' });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/tasks/:id/edit
      const editMatch = path.match(/^\/api\/tasks\/([^/]+)\/edit$/);
      if (method === 'POST' && editMatch) {
        const taskId = decodeURIComponent(editMatch[1]);
        try {
          const body = await readBody(req);
          const { command } = JSON.parse(body);
          if (!command) {
            json(res, 400, { error: 'Missing "command" in request body' });
            return;
          }
          const result = await mutations.editTaskCommand(taskId, command);
          json(res, 200, { ok: true, taskId, action: 'command_edited', tasksStarted: result.runnable.length });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/tasks/:id/edit-prompt
      const editPromptMatch = path.match(/^\/api\/tasks\/([^/]+)\/edit-prompt$/);
      if (method === 'POST' && editPromptMatch) {
        const taskId = decodeURIComponent(editPromptMatch[1]);
        try {
          const body = await readBody(req);
          const { prompt } = JSON.parse(body);
          if (!prompt) {
            json(res, 400, { error: 'Missing "prompt" in request body' });
            return;
          }
          const result = await mutations.editTaskPrompt(taskId, prompt);
          json(res, 200, { ok: true, taskId, action: 'prompt_edited', tasksStarted: result.runnable.length });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/tasks/:id/edit-type
      const editTypeMatch = path.match(/^\/api\/tasks\/([^/]+)\/edit-type$/);
      if (method === 'POST' && editTypeMatch) {
        const taskId = decodeURIComponent(editTypeMatch[1]);
        try {
          const body = await readBody(req);
          const { runnerKind, poolMemberId } = JSON.parse(body);
          if (!runnerKind) {
            json(res, 400, { error: 'Missing "runnerKind" in request body' });
            return;
          }
          const result = await mutations.editTaskType(taskId, runnerKind, poolMemberId);
          json(res, 200, { ok: true, taskId, action: 'type_edited', tasksStarted: result.runnable.length });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/tasks/:id/edit-agent
      const editAgentMatch = path.match(/^\/api\/tasks\/([^/]+)\/edit-agent$/);
      if (method === 'POST' && editAgentMatch) {
        const taskId = decodeURIComponent(editAgentMatch[1]);
        try {
          const body = await readBody(req);
          const { agent } = JSON.parse(body);
          if (!agent) {
            json(res, 400, { error: 'Missing "agent" in request body' });
            return;
          }
          const result = await mutations.editTaskAgent(taskId, agent);
          json(res, 200, { ok: true, taskId, action: 'agent_edited', tasksStarted: result.runnable.length });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/tasks/:id/gate-policy
      const gatePolicyMatch = path.match(/^\/api\/tasks\/([^/]+)\/gate-policy$/);
      if (method === 'POST' && gatePolicyMatch) {
        const taskId = decodeURIComponent(gatePolicyMatch[1]);
        try {
          const body = await readBody(req);
          const parsed = JSON.parse(body);
          const updates = Array.isArray(parsed?.updates) ? parsed.updates : [];
          if (updates.length === 0) {
            json(res, 400, { error: 'Missing non-empty "updates" array in request body' });
            return;
          }
          const result = await mutations.setTaskExternalGatePolicies(taskId, updates);
          json(res, 200, { ok: true, taskId, action: 'gate_policy_updated', tasksStarted: result.runnable.length });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/workflows/:id/gate-policy
      const workflowGatePolicyMatch = path.match(/^\/api\/workflows\/([^/]+)\/gate-policy$/);
      if (method === 'POST' && workflowGatePolicyMatch) {
        const workflowId = decodeURIComponent(workflowGatePolicyMatch[1]);
        try {
          const body = await readBody(req);
          const parsed = JSON.parse(body);
          const updates = Array.isArray(parsed?.updates) ? parsed.updates : [];
          if (updates.length === 0) {
            json(res, 400, { error: 'Missing non-empty "updates" array in request body' });
            return;
          }
          const result = await mutations.setWorkflowExternalGatePolicies(workflowId, updates);
          json(res, 200, { ok: true, workflowId, action: 'workflow_gate_policy_updated', tasksStarted: result.runnable.length });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // PATCH /api/tasks/:id/metadata
      const taskMetadataMatch = path.match(/^\/api\/tasks\/([^/]+)\/metadata$/);
      if (method === 'PATCH' && taskMetadataMatch) {
        const taskId = decodeURIComponent(taskMetadataMatch[1]);
        try {
          const body = await readBody(req);
          const patch = parseMetadataPatchBody(body);
          const result = await mutations.setTaskMetadata(taskId, patch.fieldPath, patch.value, { raw: patch.raw });
          json(res, 200, { ok: true, ...result });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // DELETE /api/workflows/:id
      const wfDeleteMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
      if (method === 'DELETE' && wfDeleteMatch) {
        const workflowId = decodeURIComponent(wfDeleteMatch[1]);
        try {
          await deleteWorkflow(workflowId);
          json(res, 200, { ok: true, workflowId, action: 'deleted' });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/workflows/:id/detach
      const wfDetachMatch = path.match(/^\/api\/workflows\/([^/]+)\/detach$/);
      if (method === 'POST' && wfDetachMatch) {
        const workflowId = decodeURIComponent(wfDetachMatch[1]);
        try {
          const body = await readBody(req);
          const { upstreamWorkflowId } = JSON.parse(body);
          if (!upstreamWorkflowId) {
            json(res, 400, { error: 'Missing "upstreamWorkflowId" in request body' });
            return;
          }
          await detachWorkflow(workflowId, String(upstreamWorkflowId));
          const message = `Detached downstream workflow ${workflowId} from upstream workflow ${String(upstreamWorkflowId)}`;
          apiLogger?.info(message, { module: 'api' });
          json(res, 200, {
            ok: true,
            workflowId,
            upstreamWorkflowId,
            action: 'detached',
            message,
          });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // POST /api/workflows/:id/merge-mode
      const wfMergeModeMatch = path.match(/^\/api\/workflows\/([^/]+)\/merge-mode$/);
      if (method === 'POST' && wfMergeModeMatch) {
        const workflowId = decodeURIComponent(wfMergeModeMatch[1]);
        try {
          const body = await readBody(req);
          const { mode } = JSON.parse(body);
          if (!mode) {
            json(res, 400, { error: 'Missing "mode" in request body' });
            return;
          }
          await mutations.setWorkflowMergeMode(workflowId, mode);
          json(res, 200, { ok: true, workflowId, action: 'merge_mode_set', mode });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      // PATCH /api/workflows/:id/metadata
      const wfMetadataMatch = path.match(/^\/api\/workflows\/([^/]+)\/metadata$/);
      if (method === 'PATCH' && wfMetadataMatch) {
        const workflowId = decodeURIComponent(wfMetadataMatch[1]);
        try {
          const body = await readBody(req);
          const patch = parseMetadataPatchBody(body);
          const result = await mutations.setWorkflowMetadata(workflowId, patch.fieldPath, patch.value, { raw: patch.raw });
          json(res, 200, { ok: true, ...result });
        } catch (err) {
          json(res, httpStatusForError(err), { error: errorMessage(err) });
        }
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (err) {
      apiLogger?.error(`Unhandled error: ${err}`, { module: 'api-server' });
      json(res, 500, { error: 'Internal server error' });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    apiLogger?.info(`Listening on http://127.0.0.1:${port}`, { module: 'api-server' });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      apiLogger?.warn(`Port ${port} in use, API server not started`, { module: 'api-server' });
    } else {
      apiLogger?.error(`Server error: ${err}`, { module: 'api-server' });
    }
  });

  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}
