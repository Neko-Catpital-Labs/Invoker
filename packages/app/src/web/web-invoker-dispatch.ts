/**
 * Transport-neutral `InvokerAPI` dispatch for the web bridge.
 *
 * `buildWebInvokerDispatch` returns a single function `(channel, args)` that
 * mirrors the Electron IPC handlers (reads in ipc-read-handlers.ts / main.ts,
 * mutations in api-server.ts) by calling the owner-process objects directly.
 * It runs ONLY in the owner process (the same process the REST api-server runs
 * in), so there is no IPC delegation path here.
 *
 * The web shim (packages/ui/src/web/web-invoker-client.ts) POSTs
 * `{ channel, args }`; the bridge invokes this dispatch and serialises the
 * result. Channels with no meaningful web behaviour resolve a benign value
 * (terminals) or reject with a structured `{ code }` error (everything else).
 */

import type {
  BundledSkillsStatus,
  Logger,
  SystemDiagnostics,
} from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { AgentRegistry } from '@invoker/execution-engine';
import type { ExternalGatePolicyUpdate, Orchestrator } from '@invoker/workflow-core';
import type { InvokerConfig } from '../config.js';
import type { ApiMutationFacade } from '../api-server.js';
import { buildReviewGateQueryResponse } from '../review-gate-query.js';
import { buildCurrentActionGraphSnapshot } from '../action-graph-snapshot.js';
import { collectSystemDiagnostics } from '../system-diagnostics.js';
import { resolveAgentSession } from '../headless-query-list.js';
import { buildTaskGraphSnapshot } from './task-graph-snapshot.js';

export interface WebInvokerDispatchDeps {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  mutations: ApiMutationFacade;
  agentRegistry: AgentRegistry;
  loadConfig: () => InvokerConfig;
  /** Monotonic task-delta stream watermark used by the snapshot resync contract. */
  getStreamSequence: () => number;
  /** Resync the owner graph and push a fresh snapshot to live (SSE) clients. */
  refreshTaskGraph: () => Promise<void>;
  deleteWorkflow: (workflowId: string) => Promise<void>;
  detachWorkflow: (workflowId: string, upstreamWorkflowId: string) => Promise<void>;
  /** Optional richer reads available in the GUI owner; safe fallbacks otherwise. */
  getSystemDiagnostics?: () => SystemDiagnostics;
  getBundledSkillsStatus?: () => BundledSkillsStatus;
  checkPrStatuses?: () => void | Promise<void>;
  logger?: Logger;
}

export type WebInvokerDispatch = (channel: string, args: unknown[]) => Promise<unknown>;

class WebDispatchError extends Error {
  readonly code: string;
  readonly channel: string;
  constructor(code: string, channel: string, message: string) {
    super(message);
    this.name = 'WebDispatchError';
    this.code = code;
    this.channel = channel;
  }
}

function unsupported(channel: string): never {
  throw new WebDispatchError(
    'unsupported_on_web',
    channel,
    `Channel "${channel}" is not supported on the web surface`,
  );
}

export function buildWebInvokerDispatch(deps: WebInvokerDispatchDeps): WebInvokerDispatch {
  const { orchestrator, persistence, mutations, agentRegistry } = deps;

  const reviewGate = (workflowId: string) => {
    const workflow = persistence.loadWorkflow(workflowId);
    if (!workflow) return null;
    const tasks = persistence.loadTasks(workflowId);
    return buildReviewGateQueryResponse({ workflowId, workflow, tasks });
  };

  return async function dispatch(channel: string, args: unknown[]): Promise<unknown> {
    switch (channel) {
      // ── Reads ─────────────────────────────────────────────
      case 'invoker:get-tasks':
        return buildTaskGraphSnapshot({
          orchestrator,
          persistence,
          getStreamSequence: deps.getStreamSequence,
        });
      case 'invoker:refresh-task-graph':
        await deps.refreshTaskGraph();
        return undefined;
      case 'invoker:list-workflows':
        return persistence.listWorkflows();
      case 'invoker:load-workflow': {
        const workflowId = String(args[0]);
        orchestrator.syncFromDb(workflowId);
        return {
          workflow: persistence.loadWorkflow(workflowId),
          tasks: persistence.loadTasks(workflowId),
        };
      }
      case 'invoker:get-status':
        return orchestrator.getWorkflowStatus();
      case 'invoker:get-queue-status':
        return orchestrator.getQueueStatus();
      case 'invoker:get-action-graph':
        return buildCurrentActionGraphSnapshot({
          orchestrator,
          persistence,
          invokerConfig: deps.loadConfig(),
        });
      case 'invoker:get-events':
        return persistence.getEvents(String(args[0]));
      case 'invoker:get-task-output':
        return persistence.getTaskOutput(String(args[0]));
      case 'invoker:get-task-by-id':
        return orchestrator.getTask(String(args[0])) ?? null;
      case 'invoker:get-all-completed-tasks':
        return persistence.loadAllCompletedTasks();
      case 'invoker:get-review-gate':
        return reviewGate(String(args[0]));
      case 'invoker:get-claude-session':
        return resolveAgentSession(String(args[0]), 'claude', agentRegistry, orchestrator.getAllTasks());
      case 'invoker:get-agent-session':
        return resolveAgentSession(
          String(args[0]),
          args[1] ? String(args[1]) : 'claude',
          agentRegistry,
          orchestrator.getAllTasks(),
        );
      case 'invoker:get-remote-targets':
        return Object.keys(deps.loadConfig().remoteTargets ?? {});
      case 'invoker:get-execution-pools':
        return Object.keys(deps.loadConfig().executionPools ?? {});
      case 'invoker:get-execution-agents':
        return agentRegistry.listExecution().map((a) => a.name);
      case 'invoker:get-system-diagnostics':
        return (
          deps.getSystemDiagnostics?.() ??
          collectSystemDiagnostics({
            appVersion: 'unknown',
            isPackaged: false,
            platform: process.platform,
            arch: process.arch,
          })
        );
      case 'invoker:get-bundled-skills-status':
        if (!deps.getBundledSkillsStatus) return unsupported(channel);
        return deps.getBundledSkillsStatus();
      case 'invoker:get-activity-logs':
        return persistence.getActivityLogs(
          typeof args[0] === 'number' ? (args[0] as number) : 0,
          typeof args[1] === 'number' ? (args[1] as number) : 2000,
        );
      case 'invoker:search':
        return persistence.searchWorkflowsAndTasks(
          String(args[0]),
          (args[1] as Parameters<SQLiteAdapter['searchWorkflowsAndTasks']>[1]) ?? undefined,
        );
      case 'invoker:get-runtime-status':
        return { ownerMode: true, readOnly: false, mode: 'local-owner' };
      case 'invoker:get-ui-perf-stats':
        return {};
      case 'invoker:report-ui-perf':
        return undefined;
      case 'invoker:check-pr-statuses':
      case 'invoker:check-pr-status':
        await deps.checkPrStatuses?.();
        return undefined;

      // ── Mutations (route to the facade exactly as api-server.ts) ──
      case 'invoker:approve':
        return mutations.approveTask(String(args[0]));
      case 'invoker:reject':
        return mutations.rejectTask(String(args[0]), args[1] === undefined ? undefined : String(args[1]));
      case 'invoker:provide-input':
        return mutations.provideInput(String(args[0]), String(args[1]));
      case 'invoker:restart-task':
        return mutations.retryTask(String(args[0]));
      case 'invoker:recreate-task':
        return mutations.recreateTask(String(args[0]));
      case 'invoker:recreate-downstream':
        return mutations.recreateDownstream(String(args[0]));
      case 'invoker:cancel-task':
        return mutations.cancelTask(String(args[0]));
      case 'invoker:recreate-workflow':
        return mutations.recreateWorkflow(String(args[0]));
      case 'invoker:retry-workflow':
        return mutations.retryWorkflow(String(args[0]));
      case 'invoker:cancel-workflow':
        return mutations.cancelWorkflow(String(args[0]));
      case 'invoker:rebase-retry':
        return mutations.rebaseRetry(String(args[0]));
      case 'invoker:rebase-recreate':
        return mutations.rebaseRecreate(String(args[0]));
      case 'invoker:edit-task-command':
        return mutations.editTaskCommand(String(args[0]), String(args[1]));
      case 'invoker:edit-task-prompt':
        return mutations.editTaskPrompt(String(args[0]), String(args[1]));
      case 'invoker:edit-task-agent':
        return mutations.editTaskAgent(String(args[0]), String(args[1]));
      case 'invoker:edit-task-type':
        return mutations.editTaskType(
          String(args[0]),
          String(args[1]),
          args[2] === undefined ? undefined : String(args[2]),
        );
      case 'invoker:set-task-external-gate-policies':
        return mutations.setTaskExternalGatePolicies(
          String(args[0]),
          (args[1] as ExternalGatePolicyUpdate[]) ?? [],
        );
      case 'invoker:resolve-conflict':
        return mutations.resolveConflict(String(args[0]), args[1] === undefined ? undefined : String(args[1]));
      case 'invoker:set-merge-mode':
        return mutations.setWorkflowMergeMode(String(args[0]), String(args[1]));
      case 'invoker:detach-workflow':
        return deps.detachWorkflow(String(args[0]), String(args[1]));
      case 'invoker:delete-workflow':
        return deps.deleteWorkflow(String(args[0]));

      // ── Terminals: no pty over HTTP — degrade gracefully ──
      case 'invoker:open-terminal':
        return { opened: false, reason: 'Terminals are not available in the web UI' };
      case 'invoker:terminal-list':
        return [];
      case 'invoker:terminal-write':
      case 'invoker:terminal-resize':
      case 'invoker:terminal-close':
        return { ok: false, reason: 'unsupported' };

      // ── Mutations not exposed on the facade / global lifecycle ──
      case 'invoker:select-experiment':
      case 'invoker:set-merge-branch':
      case 'invoker:approve-merge':
      case 'invoker:fix-with-agent':
      case 'invoker:edit-task-pool':
      case 'invoker:replace-task':
      case 'invoker:load-plan':
      case 'invoker:plan-from-goal':
      case 'invoker:start':
      case 'invoker:stop':
      case 'invoker:clear':
      case 'invoker:resume-workflow':
      case 'invoker:delete-all-workflows':
      case 'invoker:delete-all-workflows-bulk':
      case 'invoker:cleanup-worktrees':
      case 'invoker:install-bundled-skills':
      case 'invoker:update-invoker-cli':
        return unsupported(channel);

      default:
        throw new WebDispatchError('unknown_channel', channel, `Unknown channel "${channel}"`);
    }
  };
}
