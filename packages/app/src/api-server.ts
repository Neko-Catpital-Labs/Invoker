/**
 * HTTP API Server — Lightweight control plane for a running Invoker instance.
 *
 * Binds to 127.0.0.1 only (no external access). Default port 4100,
 * configurable via INVOKER_API_PORT env var.
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
 *   POST   /api/tasks/:id/approve
 *   POST   /api/tasks/:id/reject       body: { reason? }
 *   POST   /api/tasks/:id/input        body: { text }
 *   POST   /api/tasks/:id/edit         body: { command }
 *   POST   /api/tasks/:id/edit-type    body: { familiarType, remoteTargetId? }
 *   POST   /api/workflows/:id/restart
 *   POST   /api/workflows/:id/merge-mode  body: { mode }
 *   DELETE /api/workflows/:id
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Orchestrator } from '@invoker/core';
import type { SQLiteAdapter } from '@invoker/persistence';
import type { FamiliarRegistry, TaskExecutor } from '@invoker/executors';
import {
  recreateWorkflow as sharedRecreateWorkflow,
  restartTask as sharedRestartTask,
  rejectTask as sharedRejectTask,
  provideInput as sharedProvideInput,
  editTaskCommand as sharedEditTaskCommand,
  editTaskType as sharedEditTaskType,
  setWorkflowMergeMode as sharedSetWorkflowMergeMode,
} from './workflow-actions.js';

export interface ApiServerDeps {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  familiarRegistry: FamiliarRegistry;
  taskExecutor: TaskExecutor;
  killRunningTask?: (taskId: string) => Promise<void>;
  cancelTask?: (taskId: string) => Promise<{ cancelled: string[]; runningCancelled: string[] }>;
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
    for (const key of ['startedAt', 'completedAt', 'lastHeartbeatAt']) {
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

export function startApiServer(deps: ApiServerDeps): ApiServer {
  const { orchestrator, persistence, familiarRegistry, taskExecutor, killRunningTask, cancelTask } = deps;
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
          const result = cancelTask
            ? await cancelTask(taskId)
            : orchestrator.cancelTask(taskId);
          json(res, 200, { ok: true, ...result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const statusCode = message.includes('not found') ? 404 : 400;
          json(res, statusCode, { error: message });
        }
        return;
      }

      // POST /api/tasks/:id/restart
      const restartMatch = path.match(/^\/api\/tasks\/([^/]+)\/restart$/);
      if (method === 'POST' && restartMatch) {
        const taskId = decodeURIComponent(restartMatch[1]);
        try {
          await killRunningTask?.(taskId);
          const started = sharedRestartTask(taskId, { orchestrator });
          const runnable = started.filter(t => t.status === 'running');
          await taskExecutor.executeTasks(runnable);
          json(res, 200, { ok: true, taskId, action: 'restarted', tasksStarted: runnable.length });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // POST /api/tasks/:id/approve
      const approveMatch = path.match(/^\/api\/tasks\/([^/]+)\/approve$/);
      if (method === 'POST' && approveMatch) {
        const taskId = decodeURIComponent(approveMatch[1]);
        try {
          const started = await orchestrator.approve(taskId);
          const postFixMerge = started.filter(t => t.status === 'running' && t.config.isMergeNode && t.id === taskId);
          for (const task of postFixMerge) {
            taskExecutor.publishAfterFix(task).catch(err => {
              console.error(`[api] approve: publishAfterFix failed for "${task.id}":`, err);
            });
          }
          const runnable = started.filter(t => t.status === 'running' && !(t.config.isMergeNode && t.id === taskId));
          if (runnable.length > 0) await taskExecutor.executeTasks(runnable);
          json(res, 200, { ok: true, taskId, action: 'approved' });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
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
          sharedRejectTask(taskId, { orchestrator }, reason);
          json(res, 200, { ok: true, taskId, action: 'rejected', reason });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // GET /api/workflows
      if (method === 'GET' && path === '/api/workflows') {
        const workflows = persistence.listWorkflows();
        json(res, 200, workflows);
        return;
      }

      // POST /api/workflows/:id/restart
      const wfRestartMatch = path.match(/^\/api\/workflows\/([^/]+)\/restart$/);
      if (method === 'POST' && wfRestartMatch) {
        const workflowId = decodeURIComponent(wfRestartMatch[1]);
        try {
          const started = sharedRecreateWorkflow(workflowId, { persistence, orchestrator });
          const runnable = started.filter(t => t.status === 'running');
          await taskExecutor.executeTasks(runnable);
          json(res, 200, { ok: true, workflowId, action: 'restarted', tasksStarted: runnable.length });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
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
          sharedProvideInput(taskId, text, { orchestrator });
          json(res, 200, { ok: true, taskId, action: 'input_provided' });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
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
          const started = sharedEditTaskCommand(taskId, command, { orchestrator });
          const runnable = started.filter(t => t.status === 'running');
          await taskExecutor.executeTasks(runnable);
          json(res, 200, { ok: true, taskId, action: 'command_edited', tasksStarted: runnable.length });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // POST /api/tasks/:id/edit-type
      const editTypeMatch = path.match(/^\/api\/tasks\/([^/]+)\/edit-type$/);
      if (method === 'POST' && editTypeMatch) {
        const taskId = decodeURIComponent(editTypeMatch[1]);
        try {
          const body = await readBody(req);
          const { familiarType, remoteTargetId } = JSON.parse(body);
          if (!familiarType) {
            json(res, 400, { error: 'Missing "familiarType" in request body' });
            return;
          }
          const started = sharedEditTaskType(taskId, familiarType, { orchestrator }, remoteTargetId);
          const runnable = started.filter(t => t.status === 'running');
          await taskExecutor.executeTasks(runnable);
          json(res, 200, { ok: true, taskId, action: 'type_edited', tasksStarted: runnable.length });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // DELETE /api/workflows/:id
      const wfDeleteMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
      if (method === 'DELETE' && wfDeleteMatch) {
        const workflowId = decodeURIComponent(wfDeleteMatch[1]);
        try {
          orchestrator.deleteWorkflow(workflowId);
          json(res, 200, { ok: true, workflowId, action: 'deleted' });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
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
          await sharedSetWorkflowMergeMode(workflowId, mode, { orchestrator, persistence, taskExecutor });
          json(res, 200, { ok: true, workflowId, action: 'merge_mode_set', mode });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[api-server] Unhandled error:', err);
      json(res, 500, { error: 'Internal server error' });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[api-server] Listening on http://127.0.0.1:${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[api-server] Port ${port} in use, API server not started`);
    } else {
      console.error('[api-server] Server error:', err);
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
