/**
 * HTTP API Server — Lightweight control plane for a running Invoker instance.
 *
 * Binds to 127.0.0.1 only (no external access). Default port 4100,
 * configurable via INVOKER_API_PORT env var.
 *
 * Read endpoints:
 *   GET /api/health
 *   GET /api/status
 *   GET /api/tasks          ?status=running
 *   GET /api/tasks/:id
 *
 * Write endpoints:
 *   POST /api/tasks/:id/cancel
 *   POST /api/tasks/:id/restart
 *   POST /api/tasks/:id/approve
 *   POST /api/tasks/:id/reject   body: { reason? }
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Orchestrator } from '@invoker/core';
import type { SQLiteAdapter } from '@invoker/persistence';
import type { FamiliarRegistry, TaskExecutor } from '@invoker/executors';

export interface ApiServerDeps {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  familiarRegistry: FamiliarRegistry;
  taskExecutor: TaskExecutor;
  killRunningTask?: (taskId: string) => Promise<void>;
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
  const { orchestrator, persistence, familiarRegistry, taskExecutor, killRunningTask } = deps;
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
        const task = orchestrator.getTask(taskId);
        if (!task) {
          json(res, 404, { error: `Task "${taskId}" not found` });
          return;
        }
        if (task.status !== 'running') {
          json(res, 400, { error: `Task "${taskId}" is not running (status: ${task.status})` });
          return;
        }
        // Kill via familiar and mark as failed
        await Promise.all(familiarRegistry.getAll().map(f => f.destroyAll()));
        orchestrator.handleWorkerResponse({
          requestId: `api-cancel-${taskId}`,
          actionId: taskId,
          status: 'failed',
          outputs: { exitCode: 1, error: 'Cancelled via API' },
        });
        json(res, 200, { ok: true, taskId, action: 'cancelled' });
        return;
      }

      // POST /api/tasks/:id/restart
      const restartMatch = path.match(/^\/api\/tasks\/([^/]+)\/restart$/);
      if (method === 'POST' && restartMatch) {
        const taskId = decodeURIComponent(restartMatch[1]);
        try {
          await killRunningTask?.(taskId);
          const started = orchestrator.restartTask(taskId);
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
          await orchestrator.approve(taskId);
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
          const task = orchestrator.getTask(taskId);
          if (task?.execution.pendingFixError !== undefined) {
            orchestrator.revertConflictResolution(taskId, task.execution.pendingFixError);
          } else {
            orchestrator.reject(taskId, reason);
          }
          json(res, 200, { ok: true, taskId, action: 'rejected', reason });
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
