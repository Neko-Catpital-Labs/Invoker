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
  BundledSkillsInstallMode,
  CliInstallResult,
  InvokerSetupRequest,
  InvokerSetupResult,
  Logger,
  SystemDiagnostics,
  WorkerDecisionsRequest,
  WorkerStatusSnapshot,
} from '@invoker/contracts';
import { IpcChannels } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { AgentRegistry } from '@invoker/execution-engine';
import type { ExternalGatePolicyUpdate, Orchestrator } from '@invoker/workflow-core';
import {
  DEFAULT_SLACK_HARNESS_PRESETS,
  filterExecutionHarnesses,
  resolveDefaultTaskExecutionSettings,
  type InvokerConfig,
} from '../config.js';
import { listInAppPlanningPresets } from '../in-app-planner.js';
import type { ApiMutationFacade } from '../api-server.js';
import { getEventsPage } from '../get-events-page.js';
import { buildReviewGateQueryResponse } from '../review-gate-query.js';
import { buildCurrentActionGraphSnapshot } from '../action-graph-snapshot.js';
import { collectSystemDiagnostics } from '../system-diagnostics.js';
import { resolveAgentSession } from '../headless-query-list.js';
import { listWorkerActionHistory, listWorkerDecisions } from '../worker-control.js';
import { buildTaskGraphSnapshot } from './task-graph-snapshot.js';
import type { TaskTerminalAdapter } from '../task-terminal-adapter.js';
import { checkInvokerSurfaceAccess } from '../invoker-surface-access.js';
import type { OwnerCapabilityRegistry } from '../owner-capability-registry.js';


/**
 * Consumer-side port for planning terminals. The owner hosts pass the adapter
 * built by `createPlanningTerminalAdapter` (terminal-session-ipc.ts), which
 * satisfies this shape structurally; declaring the port here keeps the web
 * dispatch free of a hard dependency on the Electron IPC module's exports.
 */
export interface WebPlanningTerminals {
  open(planningSessionId: string): Promise<{ opened: boolean; reason?: string; session?: unknown }>;
  list(): unknown[] | Promise<unknown[]>;
  write(sessionId: string, data: string): { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>;
  resize(sessionId: string, cols: number, rows: number): { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>;
  appliedSize(sessionId: string): { cols: number; rows: number } | null | Promise<{ cols: number; rows: number } | null>;
  close(sessionId: string): { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>;
}

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
  installBundledSkills?: (mode?: BundledSkillsInstallMode) => BundledSkillsStatus;
  updateInvokerCli?: () => CliInstallResult;
  runInvokerCliSetup?: (request: InvokerSetupRequest) => Promise<InvokerSetupResult>;
  checkPrStatuses?: () => void | Promise<void>;
  getWorkers?: () => WorkerStatusSnapshot;
  taskTerminals?: TaskTerminalAdapter;
  ownerCapabilities?: Pick<OwnerCapabilityRegistry, 'has' | 'invoke'>;
  planningTerminals?: WebPlanningTerminals;
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

function providerMissing(channel: string): never {
  throw new WebDispatchError(
    'capability_provider_missing',
    channel,
    `No capability provider is available for "${channel}"`,
  );
}

function planningAgentForPreset(config: InvokerConfig, presetKey: unknown): string | undefined {
  const key = typeof presetKey === 'string' && presetKey.trim()
    ? presetKey.trim()
    : config.defaultSlackHarnessPreset ?? 'cursor+claude';
  const preset = config.slackHarnessPresets?.[key] ?? DEFAULT_SLACK_HARNESS_PRESETS[key];
  if (!preset) return undefined;
  const tool = preset.tool.trim().toLowerCase();
  if ((tool === 'cursor' || tool === 'omp') && preset.model?.trim()) {
    return preset.model.trim();
  }
  return tool;
}

function requestedExecutionAgents(
  channel: string,
  args: unknown[],
  config: InvokerConfig,
): readonly (string | undefined)[] {
  switch (channel) {
    case 'invoker:fix-with-agent':
      return [typeof args[1] === 'string' ? args[1] : config.autoFixAgent];
    case 'invoker:resolve-conflict':
      return [typeof args[1] === 'string' ? args[1] : config.conflictResolutionAgent];
    case 'invoker:edit-task-agent':
      return [typeof args[1] === 'string' ? args[1] : undefined];
    case 'invoker:replace-task':
      return Array.isArray(args[1])
        ? args[1].map((replacement) => (
            replacement && typeof replacement === 'object'
              ? (replacement as { executionAgent?: unknown }).executionAgent
              : undefined
          )).map((agent) => typeof agent === 'string' ? agent : undefined)
        : [];
    case 'invoker:plan-from-goal':
    case 'invoker:planning-chat-create': {
      const request = args[0] && typeof args[0] === 'object'
        ? args[0] as { presetKey?: unknown }
        : undefined;
      return [planningAgentForPreset(config, request?.presetKey)];
    }
    case 'invoker:planning-chat-send': {
      const request = args[0] && typeof args[0] === 'object'
        ? args[0] as { presetKey?: unknown }
        : undefined;
      return request?.presetKey === undefined
        ? []
        : [planningAgentForPreset(config, request.presetKey)];
    }
    default:
      return [];
  }
}

function assertOwnerCapabilityAccess(
  deps: WebInvokerDispatchDeps,
  channel: string,
  args: unknown[],
): void {
  const config = deps.loadConfig();
  for (const executionAgent of requestedExecutionAgents(channel, args, config)) {
    const decision = checkInvokerSurfaceAccess(config, executionAgent);
    if (!decision.allowed) {
      throw new WebDispatchError(decision.code, channel, decision.message);
    }
  }
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
    if (deps.ownerCapabilities?.has(channel)) {
      assertOwnerCapabilityAccess(deps, channel, args);
      return deps.ownerCapabilities.invoke(channel, args);
    }

    switch (channel) {
      // ── Reads ─────────────────────────────────────────────
      case 'invoker:get-tasks':
        return buildTaskGraphSnapshot({
          orchestrator: {
            syncAllFromDb: () => orchestrator.syncAllFromDb(),
            getAllTasks: () => orchestrator.getAllTasks(),
          },
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
        return orchestrator.getQueueStatus({
          refresh: (args[0] as { refresh?: boolean } | undefined)?.refresh === true,
        });
      case 'invoker:get-worker-status':
      case 'invoker:get-workers':
        return deps.getWorkers?.() ?? { generatedAt: new Date().toISOString(), workers: [] };
      case 'invoker:get-worker-decisions':
        return listWorkerDecisions(
          persistence,
          (args[0] ?? {}) as WorkerDecisionsRequest,
        );
      case 'invoker:get-worker-action-history':
        return listWorkerActionHistory(
          persistence,
          (args[0] ?? {}) as Parameters<typeof listWorkerActionHistory>[1],
        );
      case 'invoker:get-action-graph':
        return buildCurrentActionGraphSnapshot({
          orchestrator,
          persistence,
          invokerConfig: deps.loadConfig(),
        });
      case 'invoker:get-events':
        return getEventsPage(persistence, String(args[0]), args[1]);
      case 'invoker:get-task-output':
        return persistence.getTaskOutput(String(args[0]));
      case 'invoker:get-task-by-id':
        return orchestrator.getTask(String(args[0])) ?? null;
      case 'invoker:get-all-completed-tasks':
        return persistence.loadAllCompletedTasks();
      case 'invoker:get-history-tasks':
        return persistence.loadAllHistoryTasks();
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
      case 'invoker:get-execution-harnesses':
        return filterExecutionHarnesses(agentRegistry.listExecutionHarnesses(), deps.loadConfig());
      case 'invoker:get-planning-presets':
        return listInAppPlanningPresets(deps.loadConfig());
      case 'invoker:get-execution-defaults':
        return resolveDefaultTaskExecutionSettings(deps.loadConfig());
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
        if (!deps.getBundledSkillsStatus) return providerMissing(channel);
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
      case 'invoker:report-ui-perf': {
        // Mirror the GUI handler (gui-mutation-handlers.ts): persist every
        // renderer metric to the activity log so web-surface interactions are
        // diagnosable after the fact. Previously a silent no-op, which left
        // web incidents with no client-side record at all.
        const payload = {
          ts: new Date().toISOString(),
          metric: String(args[0] ?? ''),
          ...((args[1] ?? {}) as Record<string, unknown>),
        };
        try {
          persistence.writeActivityLog('ui-perf', 'info', JSON.stringify(payload));
        } catch {
          // DB might be locked; matching the GUI handler's tolerance.
        }
        return undefined;
      }
      case 'invoker:trace-renderer-task-graph-event':
      case 'invoker:trace-renderer-workflow-event':
        return undefined;
      case 'invoker:check-pr-statuses':
      case 'invoker:check-pr-status':
        await deps.checkPrStatuses?.();
        return undefined;
      case 'invoker:install-bundled-skills':
        if (!deps.installBundledSkills) return providerMissing(channel);
        return deps.installBundledSkills(args[0] as BundledSkillsInstallMode | undefined);
      case 'invoker:update-invoker-cli':
        if (!deps.updateInvokerCli) return providerMissing(channel);
        return deps.updateInvokerCli();
      case 'invoker:run-invoker-cli-setup':
        if (!deps.runInvokerCliSetup) return providerMissing(channel);
        return deps.runInvokerCliSetup(args[0] as InvokerSetupRequest);

      // ── Mutations (route to the facade exactly as api-server.ts) ──
      case 'invoker:approve':
        return mutations.approveTask(String(args[0]));
      case 'invoker:reject':
        return mutations.rejectTask(String(args[0]), args[1] === undefined ? undefined : String(args[1]));
      case 'invoker:provide-input':
        return mutations.provideInput(String(args[0]), String(args[1]));
      case 'invoker:retry-task':
        return mutations.retryTask(String(args[0]));
      case 'invoker:recreate-task':
        return mutations.recreateTask(String(args[0]));
      case 'invoker:recreate-downstream':
        return mutations.recreateDownstream(String(args[0]));
      case 'invoker:cancel-task':
        return mutations.cancelTask(String(args[0]));
      case 'invoker:delete-task':
        return mutations.deleteTask(String(args[0]));
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
      case 'invoker:spawn-repair-workflow':
        return mutations.spawnRepairWorkflow(args[0]);
      case 'invoker:edit-task-command':
        return mutations.editTaskCommand(String(args[0]), String(args[1]));
      case 'invoker:edit-task-prompt':
        return mutations.editTaskPrompt(String(args[0]), String(args[1]));
      case 'invoker:edit-task-agent':
        assertOwnerCapabilityAccess(deps, channel, args);
        return mutations.editTaskAgent(String(args[0]), String(args[1]));
      case 'invoker:edit-task-model':
        return mutations.editTaskModel(String(args[0]), args[1] === undefined || args[1] === null ? null : String(args[1]));
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
        assertOwnerCapabilityAccess(deps, channel, args);
        return mutations.resolveConflict(String(args[0]), args[1] === undefined ? undefined : String(args[1]));
      case 'invoker:set-workflow-merge-mode':
        return mutations.setWorkflowMergeMode(String(args[0]), String(args[1]));
      case 'invoker:detach-workflow':
        return deps.detachWorkflow(String(args[0]), String(args[1]));
      case 'invoker:delete-workflow':
        return deps.deleteWorkflow(String(args[0]));

      // ── Task terminals: supported when the owner wires an adapter ──
      case 'invoker:open-terminal':
        if (!deps.taskTerminals) {
          return { opened: false, reason: 'Terminals are not available in the web UI' };
        }
        return deps.taskTerminals.open(String(args[0]));
      case 'invoker:terminal-list':
        if (!deps.taskTerminals) {
          return [];
        }
        return deps.taskTerminals.list();
      case 'invoker:terminal-write':
        if (!deps.taskTerminals) {
          return { ok: false, reason: 'unsupported' };
        }
        return deps.taskTerminals.write(String(args[0]), String(args[1] ?? ''));
      case 'invoker:terminal-resize':
        if (!deps.taskTerminals) {
          return { ok: false, reason: 'unsupported' };
        }
        return deps.taskTerminals.resize(
          String(args[0]),
          Number(args[1]),
          Number(args[2]),
        );
      case 'invoker:terminal-close':
        if (!deps.taskTerminals) {
          return { ok: false, reason: 'unsupported' };
        }
        return deps.taskTerminals.close(String(args[0]));
      case 'invoker:planning-terminal-open':
        if (deps.planningTerminals) return deps.planningTerminals.open(String(args[0]));
        return { opened: false, reason: 'Planning terminals are not available in the web UI' };
      case 'invoker:planning-terminal-list':
        return deps.planningTerminals?.list() ?? [];
      case 'invoker:planning-terminal-applied-size':
        return deps.planningTerminals?.appliedSize(String(args[0])) ?? null;
      case 'invoker:planning-terminal-write':
        if (deps.planningTerminals) return deps.planningTerminals.write(String(args[0]), String(args[1]));
        return { ok: false, reason: 'unsupported' };
      case 'invoker:planning-terminal-resize':
        if (deps.planningTerminals) {
          return deps.planningTerminals.resize(String(args[0]), Number(args[1]), Number(args[2]));
        }
        return { ok: false, reason: 'unsupported' };
      case 'invoker:planning-terminal-close':
        if (deps.planningTerminals) return deps.planningTerminals.close(String(args[0]));
        return { ok: false, reason: 'unsupported' };
      default:
        if (Object.hasOwn(IpcChannels, channel)) return providerMissing(channel);
        throw new WebDispatchError('unknown_channel', channel, `Unknown channel "${channel}"`);
    }
  };
}
