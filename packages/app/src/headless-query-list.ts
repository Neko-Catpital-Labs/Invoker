/**
 * Headless "query" command family: the read-only `query <sub>` router
 * (workflows · tasks · task · queue · review-gate · action-graph · audit ·
 * session · workers · worker-actions · cost · cost-events · costs · ui-perf · stats), the cost-event
 * collection/rollup
 * helpers, agent session resolution, and `query-select`.
 *
 * The deprecated top-level aliases (`list`, `status`, `task-status`, `queue`,
 * `audit`, `session`) route here through the `headless.ts` router. It depends on
 * `headless-shared.ts` and reuses `worker-control.ts` for the worker-decisions view.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Attempt, TaskState } from '@invoker/workflow-core';
import type { AgentSessionData, NormalizedCostEvent, WorkerActionSummary, WorkerStatusSnapshot } from '@invoker/contracts';
import { AUTO_FIX_WORKER_KIND, createWorkerRegistry, registerBuiltinWorkers, type AgentRegistry, type WorkerRuntimeDependencies } from '@invoker/execution-engine';
import type { CostAttributionAttempt } from '@invoker/data-store';
import type { CostGroupDimension } from './cost-rollup.js';
import { buildCurrentActionGraphSnapshot } from './action-graph-snapshot.js';
import { buildReviewGateQueryResponse } from './review-gate-query.js';

import {
  type HeadlessDeps,
  type QueryFlags,
  BOLD,
  RESET,
  parseQueryFlags,
  restoreWorkflowForTask,
} from './headless-shared.js';
import { resolveDefaultExecutionAgent } from './config.js';
import { registerExternalWorkersFromConfig } from './external-worker-loader.js';
import { loadAllEventsPaged } from './load-all-events-paged.js';
import { autoStartedOwnerWorkerKindsForConfig, createLocalWorkerStatusSnapshot, listWorkerDecisions, toWorkerActionSummary } from './worker-control.js';
import { renderWorkerLifecycle } from './headless-worker-lifecycle.js';
import { createRendererUiPerfCounters } from './renderer-ui-perf.js';
import {
  collectRecoveryWorkerStatus,
  type RecoveryWorkerStatus,
} from './recovery-worker-observability.js';

/**
 * The read-query family writes its formatted output through {@link writeOut}.
 * Locally (no active sink) it goes straight to `process.stdout`. When the
 * writable owner answers a delegated `cli-query` it runs the same code inside
 * {@link runReadOnlyHeadlessQueryToString}, which installs a buffering sink via
 * AsyncLocalStorage so the rendered text is captured and returned over IPC
 * instead of printed on the owner. AsyncLocalStorage keeps the sink isolated
 * per request, so concurrent delegated queries never cross output.
 */
const queryOutputSink = new AsyncLocalStorage<(chunk: string) => void>();

function writeOut(chunk: string): void {
  const sink = queryOutputSink.getStore();
  if (sink) sink(chunk);
  else process.stdout.write(chunk);
}

/**
 * Dependency subset the read-query path needs. Narrow enough that both the
 * standalone and GUI owners can supply it without building a full
 * {@link HeadlessDeps}.
 */
export type HeadlessQueryDeps = Pick<
  HeadlessDeps,
  'orchestrator' | 'persistence' | 'executionAgentRegistry' | 'invokerConfig' | 'getUiPerfStats' | 'resetUiPerfStats'
>;

export async function headlessQuery(args: string[], deps: HeadlessQueryDeps): Promise<void> {
  const subCommand = args[0];
  if (!subCommand) {
    throw new Error('Missing query sub-command. Usage: --headless query <workflows|workflow|tasks|task|task-output|container-id|queue|review-gate|action-graph|audit|session|workers|worker-actions|worker-decisions|cost|cost-events|costs|ui-perf|stats|execution-leases>');
  }
  const flags = parseQueryFlags(args.slice(1));

  const {
    formatWorkflowList, formatTaskStatus, formatWorkflowStatus,
    formatEventLog, formatQueueStatus, formatWorkflowStats, formatWorkerActions, formatWorkerDecisions,
    serializeWorkflow, serializeTask, serializeEvent, serializeWorkerAction,
    formatAsLabel, formatAsJson, formatAsJsonl,
  } = await import('./formatter.js');

  switch (subCommand) {
    case 'workflows': {
      let workflows = deps.persistence.listWorkflows();
      if (flags.status) {
        workflows = workflows.filter(wf => wf.status === flags.status);
      }
      switch (flags.output) {
        case 'label': writeOut(formatAsLabel(workflows) + '\n'); break;
        case 'json':  writeOut(formatAsJson(workflows.map(serializeWorkflow)) + '\n'); break;
        case 'jsonl': writeOut(formatAsJsonl(workflows.map(serializeWorkflow)) + '\n'); break;
        default:      writeOut(formatWorkflowList(workflows) + '\n'); break;
      }
      break;
    }
    case 'workflow': {
      const workflowId = flags.positional[0];
      if (!workflowId) throw new Error('Missing workflowId. Usage: --headless query workflow <workflowId>');
      const workflow = deps.persistence.loadWorkflow(workflowId);
      if (!workflow) throw new Error(`Workflow "${workflowId}" not found.`);
      switch (flags.output) {
        case 'label': writeOut(`${workflow.id}\n`); break;
        case 'json':  writeOut(formatAsJson(serializeWorkflow(workflow)) + '\n'); break;
        case 'jsonl': writeOut(formatAsJsonl([serializeWorkflow(workflow)]) + '\n'); break;
        default:      writeOut(formatWorkflowList([workflow]) + '\n'); break;
      }
      break;
    }
    case 'tasks': {
      const { orchestrator, persistence } = deps;
      const workflows = persistence.listWorkflows();
      if (workflows.length === 0) {
        writeOut('No workflows found. Run a plan first.\n');
        return;
      }

      // Support both:
      //   query tasks --workflow <id>
      //   query tasks <workflowId>
      const workflowFilter = flags.workflow ?? flags.positional[0];

      // Load tasks from specific workflow or latest
      const targetWorkflows = workflowFilter
        ? workflows.filter(wf => wf.id === workflowFilter)
        : [workflows[0]];

      if (targetWorkflows.length === 0) {
        throw new Error(`Workflow "${workflowFilter}" not found.`);
      }

      let allTasks: TaskState[] = [];
      for (const wf of targetWorkflows) {
        // Query must stay read-only: sync graph from DB without starting/restarting tasks.
        orchestrator.syncFromDb(wf.id);
        // Filter by workflow ID — the orchestrator may have loaded other workflows during init.
        allTasks.push(...orchestrator.getAllTasks().filter(t => t.config.workflowId === wf.id));
      }

      // Apply filters
      if (flags.status) {
        allTasks = allTasks.filter(t => t.status === flags.status);
      }
      if (flags.noMerge) {
        allTasks = allTasks.filter(t => !t.config.isMergeNode);
      }

      switch (flags.output) {
        case 'label': writeOut(formatAsLabel(allTasks) + '\n'); break;
        case 'json':  writeOut(formatAsJson(allTasks.map(serializeTask)) + '\n'); break;
        case 'jsonl': writeOut(formatAsJsonl(allTasks.map(serializeTask)) + '\n'); break;
        default: {
          for (const task of allTasks) writeOut(formatTaskStatus(task) + '\n');
          const status = orchestrator.getWorkflowStatus();
          writeOut(`\n${formatWorkflowStatus(status)}\n`);
          break;
        }
      }
      break;
    }
    case 'task': {
      const taskId = flags.positional[0];
      if (!taskId) throw new Error('Usage: --headless query task <taskId>');
      const resolved = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
      const task = deps.orchestrator.getTask(resolved);
      if (!task) throw new Error(`Task "${taskId}" not found`);

      switch (flags.output) {
        case 'label': writeOut(task.id + '\n'); break;
        case 'json':  writeOut(formatAsJson(serializeTask(task)) + '\n'); break;
        case 'jsonl': writeOut(formatAsJsonl([serializeTask(task)]) + '\n'); break;
        default:      writeOut(task.status + '\n'); break;
      }
      break;
    }
    case 'task-output': {
      const taskId = flags.positional[0];
      if (!taskId) throw new Error('Usage: --headless query task-output <taskId>');
      const resolved = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
      const output = deps.persistence.getTaskOutput(resolved);

      switch (flags.output) {
        case 'label': writeOut(output + '\n'); break;
        case 'json':  writeOut(formatAsJson({ id: resolved, output }) + '\n'); break;
        case 'jsonl': writeOut(formatAsJsonl([{ id: resolved, output }]) + '\n'); break;
        default:      writeOut(output); break;
      }
      break;
    }
    case 'container-id': {
      const taskId = flags.positional[0];
      if (!taskId) throw new Error('Usage: --headless query container-id <taskId>');
      const resolved = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
      const containerId = deps.persistence.getContainerId(resolved);

      switch (flags.output) {
        case 'json':  writeOut(formatAsJson({ id: resolved, containerId }) + '\n'); break;
        case 'jsonl': writeOut(formatAsJsonl([{ id: resolved, containerId }]) + '\n'); break;
        default:      writeOut((containerId ?? '') + '\n'); break;
      }
      break;
    }
    case 'review-gate': {
      const arg = flags.positional[0];
      if (!arg) throw new Error('Usage: --headless query review-gate <prNumber|prUrl> [--output text|json|jsonl|label]');
      const prNumber = parsePrNumber(arg);
      if (!prNumber) throw new Error(`Could not parse a PR number from "${arg}".`);
      const record = deps.persistence.findReviewGateByPr(prNumber);
      switch (flags.output) {
        case 'label': writeOut(`${record?.workflowId ?? ''}\n`); break;
        case 'json':  writeOut(formatAsJson(record ?? {}) + '\n'); break;
        case 'jsonl': writeOut(formatAsJsonl(record ? [record] : []) + '\n'); break;
        default:      if (!record) {
          writeOut(`No Invoker workflow found for PR ${prNumber}.\n`);
          break;
        }
        {
          const workflow = deps.persistence.loadWorkflow(record.workflowId);
          const tasks = deps.persistence.loadTasks(record.workflowId);
          const gate = buildReviewGateQueryResponse({ workflowId: record.workflowId, workflow, tasks });
          const substate = gate.substate ?? 'null';
          writeOut(
            `${record.workflowId}\t${record.reviewId ?? prNumber}\t${record.workflowStatus}\tgen=${record.workflowGeneration}\tsubstate=${substate}\t${record.branch ?? ''}\n`,
          );
        }
        break;
      }
      break;
    }
    case 'queue': {
      const workflows = deps.persistence.listWorkflows();
      for (const workflow of workflows) {
        deps.orchestrator.syncFromDb(workflow.id);
      }
      const status = deps.orchestrator.getQueueStatus({ refresh: false });

      switch (flags.output) {
        case 'label': {
          const ids = [...status.running.map(t => t.taskId), ...status.queued.map(t => t.taskId)];
          writeOut(ids.join('\n') + '\n');
          break;
        }
        case 'json':  writeOut(formatAsJson(status) + '\n'); break;
        case 'jsonl': {
          for (const t of status.running) writeOut(JSON.stringify({ ...t, state: 'running' }) + '\n');
          for (const t of status.queued) writeOut(JSON.stringify({ ...t, state: 'queued' }) + '\n');
          break;
        }
        default: writeOut(formatQueueStatus(status) + '\n'); break;
      }
      break;
    }
    case 'action-graph': {
      const graph = buildCurrentActionGraphSnapshot({
        orchestrator: deps.orchestrator,
        persistence: deps.persistence,
        invokerConfig: deps.invokerConfig,
      });
      switch (flags.output) {
        case 'label':
          writeOut(graph.nodes.map((node) => node.id).join('\n') + '\n');
          break;
        case 'jsonl':
          for (const node of graph.nodes) {
            writeOut(JSON.stringify({ kind: 'node', ...node }) + '\n');
          }
          for (const edge of graph.edges) {
            writeOut(JSON.stringify({ kind: 'edge', ...edge }) + '\n');
          }
          break;
        case 'json':
        default:
          writeOut(formatAsJson(graph) + '\n');
          break;
      }
      break;
    }
    case 'audit': {
      const taskId = flags.positional[0];
      if (!taskId) throw new Error('Usage: --headless query audit <taskId>');
      const events = loadAllEventsPaged(deps.persistence, taskId);

      switch (flags.output) {
        case 'label': writeOut(events.map(e => `${e.taskId}:${e.eventType}`).join('\n') + '\n'); break;
        case 'json':  writeOut(formatAsJson(events.map(serializeEvent)) + '\n'); break;
        case 'jsonl': writeOut(formatAsJsonl(events.map(serializeEvent)) + '\n'); break;
        default:      writeOut(formatEventLog(events) + '\n'); break;
      }
      break;
    }
    case 'session': {
      const taskId = flags.positional[0];
      if (!taskId) throw new Error('Usage: --headless query session <taskId>');
      // For non-text output, we'd need structured session data.
      // For now, session only supports text output; other formats fall through to text.
      await headlessSession(taskId, deps);
      break;
    }
    case 'workers': {
      const snapshot = createHeadlessWorkerStatusSnapshot(deps);
      switch (flags.output) {
        case 'label': writeOut(snapshot.workers.map((worker) => worker.kind).join('\n') + '\n'); break;
        case 'json': writeOut(formatAsJson(snapshot) + '\n'); break;
        case 'jsonl': writeOut(formatAsJsonl([snapshot]) + '\n'); break;
        default: writeOut(formatWorkerStatusSnapshot(snapshot) + '\n'); break;
      }
      break;
    }
    case 'worker-actions': {
      const workflowFilter = flags.workflow ?? flags.positional[0];
      const actions = deps.persistence.listWorkerActions({
        workflowId: workflowFilter,
        status: flags.status,
        ...(flags.decision === 'act' || flags.decision === 'skip' ? { decision: flags.decision } : {}),
      });
      switch (flags.output) {
        case 'label': writeOut(formatAsLabel(actions) + '\n'); break;
        case 'json': writeOut(formatAsJson(actions.map(serializeWorkerAction)) + '\n'); break;
        case 'jsonl': writeOut(formatAsJsonl(actions.map(serializeWorkerAction)) + '\n'); break;
        default: writeOut(formatWorkerActions(actions) + '\n'); break;
      }
      break;
    }
    case 'worker-decisions': {
      const workflowFilter = flags.workflow ?? flags.positional[0];
      const response = listWorkerDecisions(deps.persistence, {
        ...(workflowFilter ? { workflowId: workflowFilter } : {}),
        ...(flags.decision === 'act' || flags.decision === 'skip' ? { decision: flags.decision } : {}),
        ...(flags.reason ? { reason: flags.reason } : {}),
      });
      switch (flags.output) {
        case 'label': writeOut(formatAsLabel(response.actions) + '\n'); break;
        case 'json': writeOut(formatAsJson(response.actions) + '\n'); break;
        case 'jsonl': writeOut(formatAsJsonl(response.actions) + '\n'); break;
        default: writeOut(formatWorkerDecisions(response.actions) + '\n'); break;
      }
      break;
    }
    case 'ui-perf': {
      if (flags.reset) {
        deps.resetUiPerfStats?.();
      }
      const stats = deps.getUiPerfStats?.() ?? {
        ownerMode: 'local',
        ts: new Date().toISOString(),
        mainDeltaToUi: 0,
        dbPollCreated: 0,
        dbPollUpdatedAsCreated: 0,
        dbPollUpdatedAsUpdated: 0,
        ...createRendererUiPerfCounters(),
      };
      switch (flags.output) {
        case 'label':
          writeOut(String((stats as Record<string, unknown>).maxRendererEventLoopLagMs ?? 0) + '\n');
          break;
        case 'json':
          writeOut(formatAsJson(stats) + '\n');
          break;
        case 'jsonl':
          writeOut(formatAsJsonl([stats]) + '\n');
          break;
        default:
          writeOut(`${JSON.stringify(stats, null, 2)}\n`);
          break;
      }
      break;
    }
    case 'stats': {
      const { orchestrator, persistence } = deps;
      const workflows = persistence.listWorkflows();

      const completed = workflows.filter(w => w.status === 'completed').length;
      const failed = workflows.filter(w => w.status === 'failed').length;
      const running = workflows.filter(w => w.status === 'running').length;
      const terminal = completed + failed;
      const successRate = terminal > 0 ? (completed / terminal) * 100 : 0;

      // Average duration across workflows that have both timestamps.
      // startedAt/completedAt are added by the workflow-duration feature; guard for older DBs.
      const durations = (workflows as Array<typeof workflows[0] & { startedAt?: string; completedAt?: string }>)
        .filter(w => w.startedAt && w.completedAt)
        .map(w => new Date(w.completedAt!).getTime() - new Date(w.startedAt!).getTime());
      const avgDurationMs = durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : null;

      // Most-failed task descriptions across all workflows
      const failCounts = new Map<string, number>();
      for (const wf of workflows) {
        orchestrator.syncFromDb(wf.id);
        const tasks = orchestrator.getAllTasks().filter(
          t => t.config.workflowId === wf.id && !t.config.isMergeNode && t.status === 'failed',
        );
        for (const t of tasks) {
          failCounts.set(t.description, (failCounts.get(t.description) ?? 0) + 1);
        }
      }
      const mostFailedTasks = [...failCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([description, failCount]) => ({ description, failCount }));

      const stats = {
        totalWorkflows: workflows.length,
        completed,
        failed,
        running,
        successRate,
        avgDurationMs,
        mostFailedTasks,
      };

      switch (flags.output) {
        case 'label': writeOut(`${successRate.toFixed(1)}%\n`); break;
        case 'json':  writeOut(formatAsJson(stats) + '\n'); break;
        case 'jsonl': writeOut(formatAsJsonl([stats]) + '\n'); break;
        default:      writeOut(formatWorkflowStats(stats) + '\n'); break;
      }
      break;
    }
    case 'cost': {
      await headlessCost(flags, deps);
      break;
    }
    case 'cost-events': {
      await headlessCostEvents(flags, deps);
      break;
    }
    case 'costs': {
      await headlessCosts(flags, deps);
      break;
    }
    case 'execution-leases': {
      const listLeases = deps.persistence.listExecutionResourceLeases?.bind(deps.persistence);
      if (!listLeases) {
        throw new Error('Persistence adapter does not support listExecutionResourceLeases');
      }
      const nowIso = new Date().toISOString();
      const leases = listLeases()
        .filter((lease) => lease.leaseExpiresAt > nowIso)
        .map((lease) => ({
          resourceKey: lease.resourceKey,
          resourceType: lease.resourceType,
          poolId: lease.poolId ?? null,
          poolMemberId: lease.poolMemberId ?? null,
          taskId: lease.taskId ?? null,
          holderId: lease.holderId,
          acquiredAt: lease.acquiredAt,
          lastHeartbeatAt: lease.lastHeartbeatAt,
          leaseExpiresAt: lease.leaseExpiresAt,
        }));
      switch (flags.output) {
        case 'label':
          writeOut(leases.map((lease) => lease.resourceKey).join('\n') + (leases.length > 0 ? '\n' : ''));
          break;
        case 'json':
          writeOut(formatAsJson(leases) + '\n');
          break;
        case 'jsonl':
          writeOut(formatAsJsonl(leases) + '\n');
          break;
        default: {
          if (leases.length === 0) {
            writeOut('No live execution resource leases.\n');
            break;
          }
          const lines = [
            'RESOURCE_KEY\tPOOL\tMEMBER\tTASK\tHOLDER\tEXPIRES',
            ...leases.map((lease) => (
              [
                lease.resourceKey,
                lease.poolId ?? '-',
                lease.poolMemberId ?? '-',
                lease.taskId ?? '-',
                lease.holderId,
                lease.leaseExpiresAt,
              ].join('\t')
            )),
          ];
          writeOut(lines.join('\n') + '\n');
          break;
        }
      }
      break;
    }
    default:
      throw new Error(`Unknown query sub-command: "${subCommand}". Use: workflows, workflow, tasks, task, task-output, container-id, queue, review-gate, action-graph, audit, session, workers, worker-actions, worker-decisions, cost, cost-events, costs, ui-perf, stats, execution-leases`);
  }
}

/**
 * Parse a PR number from either a bare number (`999`, `#999`) or a full PR URL
 * (`https://github.com/owner/repo/pull/999`). Returns undefined when neither
 * shape matches.
 */
function parsePrNumber(arg: string): string | undefined {
  const fromUrl = arg.match(/\/pull\/(\d+)/);
  if (fromUrl) return fromUrl[1];
  const bare = arg.replace(/^#/, '');
  return /^\d+$/.test(bare) ? bare : undefined;
}

async function headlessCosts(
  flags: QueryFlags,
  deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence' | 'executionAgentRegistry'>,
): Promise<void> {
  const {
    formatGroupedCostRollups, formatCostRollup,
    serializeCostEvent,
    formatAsJson,
  } = await import('./formatter.js');
  const {
    groupCostEvents,
    serializeGroupedRollup,
  } = await import('./cost-rollup.js');
  const { rollUpCostEvents } = await import('@invoker/contracts');
  const allEvents = await collectCostEvents(flags, deps);

  if (allEvents.length === 0) {
    writeOut('No cost data available.\n');
    return;
  }

  // Group by all dimensions and output
  const grouped = groupCostEvents(allEvents);
  const totalRollup = rollUpCostEvents(allEvents);

  switch (flags.output) {
    case 'label':
      writeOut(`${totalRollup.totalTokens} tokens $${totalRollup.totalCostUsd.toFixed(4)}\n`);
      break;
    case 'json':
      writeOut(formatAsJson({
        groups: grouped.map(serializeGroupedRollup),
        total: totalRollup,
        events: allEvents.map(serializeCostEvent),
      }) + '\n');
      break;
    case 'jsonl':
      for (const event of allEvents) {
        writeOut(JSON.stringify(serializeCostEvent(event)) + '\n');
      }
      break;
    default:
      writeOut(formatGroupedCostRollups(grouped) + '\n');
      writeOut('\n');
      writeOut(formatCostRollup(totalRollup) + '\n');
      break;
  }
}

type CostQueryDeps = Pick<HeadlessDeps, 'orchestrator' | 'persistence' | 'executionAgentRegistry'>;

function resolveCostAttributionAttempt(
  task: TaskState,
  attempts: readonly CostAttributionAttempt[],
): CostAttributionAttempt | undefined {
  const sessionId = task.execution.agentSessionId?.trim();
  if (sessionId) {
    const exactSessionAttempt = attempts.find((attempt) => attempt.agentSessionId?.trim() === sessionId);
    if (exactSessionAttempt) return exactSessionAttempt;
  }

  const selectedAttemptId = task.execution.selectedAttemptId?.trim();
  if (selectedAttemptId) {
    const selectedAttempt = attempts.find((attempt) => attempt.id === selectedAttemptId);
    if (selectedAttempt) return selectedAttempt;
  }

  return attempts.at(-1);
}

async function collectCostEvents(
  flags: QueryFlags,
  deps: CostQueryDeps,
): Promise<NormalizedCostEvent[]> {
  const { attributeSessionUsage, buildAttributionContext } = await import('./cost-rollup.js');

  const workflowFilter = flags.workflow ?? flags.positional[0];
  const workflows = deps.persistence.listWorkflows();
  if (workflows.length === 0) return [];

  const targetWorkflows = workflowFilter
    ? workflows.filter(wf => wf.id === workflowFilter)
    : workflows;

  if (workflowFilter && targetWorkflows.length === 0) {
    throw new Error(`Workflow "${workflowFilter}" not found.`);
  }

  const allEvents: NormalizedCostEvent[] = [];

  for (const wf of targetWorkflows) {
    deps.orchestrator.syncFromDb(wf.id);
    const tasks = deps.orchestrator.getAllTasks().filter(
      t => t.config.workflowId === wf.id && !t.config.isMergeNode,
    );

    for (const task of tasks) {
      const attempts = deps.persistence.loadCostAttributionAttempts(task.id);
      const attributedAttempt = resolveCostAttributionAttempt(task, attempts);
      const ctx = buildAttributionContext({
        id: task.id,
        workflowId: wf.id,
        runnerKind: task.config.runnerKind ?? 'worktree',
        agentSessionId: task.execution.agentSessionId,
        lastAgentSessionId: task.execution.lastAgentSessionId,
        agentName: task.execution.agentName,
        lastAgentName: task.execution.lastAgentName,
      }, attributedAttempt?.id ?? task.execution.selectedAttemptId?.trim() ?? task.id, attributedAttempt?.agentSessionId?.trim());
      if (!ctx) continue;

      const agentName = ctx.agentName;
      const driver = deps.executionAgentRegistry?.getSessionDriver(agentName);
      if (!driver?.extractUsage) continue;

      const raw = driver.loadSession(ctx.agentSessionId);
      if (!raw) continue;

      const usageEvents = driver.extractUsage(raw);
      const attributed = attributeSessionUsage(usageEvents, ctx);
      allEvents.push(...attributed);
    }
  }

  return allEvents;
}

const VALID_GROUP_DIMENSIONS = ['workflow', 'task', 'agent', 'model', 'day'] as const;

async function headlessCost(
  flags: QueryFlags,
  deps: CostQueryDeps,
): Promise<void> {
  const {
    formatGroupedCostRollups, formatCostRollup,
    formatAsJson,
  } = await import('./formatter.js');
  const { groupCostEvents, serializeGroupedRollup } = await import('./cost-rollup.js');
  const { rollUpCostEvents } = await import('@invoker/contracts');

  // Parse --group-by flag (comma-separated dimensions)
  let dimensions: CostGroupDimension[] | undefined;
  if (flags.groupBy) {
    const parts = flags.groupBy.split(',').map(s => s.trim());
    for (const part of parts) {
      if (!(VALID_GROUP_DIMENSIONS as readonly string[]).includes(part)) {
        throw new Error(
          `Invalid --group-by dimension: "${part}". Must be one or more of: ${VALID_GROUP_DIMENSIONS.join(', ')}`,
        );
      }
    }
    dimensions = parts as CostGroupDimension[];
  }

  const allEvents = await collectCostEvents(flags, deps);

  if (allEvents.length === 0) {
    writeOut('No cost data available.\n');
    return;
  }

  const grouped = groupCostEvents(allEvents, dimensions);
  const totals = rollUpCostEvents(allEvents);
  const scope = flags.workflow ?? flags.positional[0] ?? 'all';
  const groupBy = dimensions ?? [...VALID_GROUP_DIMENSIONS];

  switch (flags.output) {
    case 'label':
      writeOut(`${totals.totalTokens} tokens $${totals.totalCostUsd.toFixed(4)}\n`);
      break;
    case 'json':
      writeOut(formatAsJson({
        scope,
        groupBy,
        totals,
        groups: grouped.map(serializeGroupedRollup),
        metadata: { eventCount: allEvents.length },
      }) + '\n');
      break;
    case 'jsonl':
      for (const group of grouped) {
        writeOut(JSON.stringify(serializeGroupedRollup(group)) + '\n');
      }
      break;
    default:
      writeOut(formatGroupedCostRollups(grouped) + '\n');
      writeOut('\n');
      writeOut(formatCostRollup(totals) + '\n');
      break;
  }
}

async function headlessCostEvents(
  flags: QueryFlags,
  deps: CostQueryDeps,
): Promise<void> {
  const {
    formatCostEvent, serializeCostEvent,
    formatAsJson, formatAsJsonl,
  } = await import('./formatter.js');

  const allEvents = await collectCostEvents(flags, deps);

  if (allEvents.length === 0) {
    writeOut('No cost events found.\n');
    return;
  }

  switch (flags.output) {
    case 'label':
      for (const event of allEvents) {
        writeOut(`${event.attribution.taskId}:${event.identity.eventId}\n`);
      }
      break;
    case 'json':
      writeOut(formatAsJson(allEvents.map(serializeCostEvent)) + '\n');
      break;
    case 'jsonl':
      writeOut(formatAsJsonl(allEvents.map(serializeCostEvent)) + '\n');
      break;
    default:
      for (const event of allEvents) {
        writeOut(formatCostEvent(event) + '\n');
      }
      break;
  }
}

export async function headlessQuerySelect(taskId: string, deps: Pick<HeadlessDeps, 'persistence'>): Promise<void> {
  if (!taskId) throw new Error('Missing taskId.');
  const selected = deps.persistence.getSelectedExperiment(taskId);
  writeOut((selected
    ? `Selected experiment for ${taskId}: ${selected}`
    : `No experiment selected for ${taskId}`) + '\n');
}

/**
 * Resolve an agent session by ID via registered SessionDriver.
 * Shared by IPC handler (main.ts) and headless CLI (below).
 *
 * Flow: driver.loadSession() → driver.fetchRemoteSession() → driver.parseSession().
 * Each agent owns its own session resolution logic.
 */
export async function resolveAgentSession(
  sessionId: string,
  agentName: string,
  registry?: AgentRegistry,
  allTasks?: TaskState[],
): Promise<AgentSessionData | null> {
  const driver = registry?.getSessionDriver(agentName);
  if (!driver) {
    return {
      agentName,
      sessionId,
      state: 'error',
      messages: [],
      reason: `No session driver registered for agent "${agentName}"`,
    };
  }

  // 1. Try local
  const raw = driver.loadSession(sessionId);
  if (raw) {
    const inspection = driver.inspectSession(raw);
    return {
      agentName,
      sessionId,
      state: inspection.state,
      reason: inspection.reason,
      messages: driver.parseSession(raw),
      source: 'local',
    };
  }

  // 2. Try remote (SSH tasks)
  if (driver.fetchRemoteSession && allTasks) {
    const sshTask = allTasks.find(
      t => t.execution.agentSessionId === sessionId
        && t.config.runnerKind === 'ssh',
    );
    if (sshTask) {
      const { loadConfig } = await import('./config.js');
      const targets = loadConfig().remoteTargets ?? {};
      const targetId = (sshTask.config as { poolMemberId?: string }).poolMemberId;
      const target = targetId
        ? targets[targetId]
        : Object.values(targets)[0];
      if (target) {
        const remoteRaw = await driver.fetchRemoteSession(sessionId, target);
        if (remoteRaw) {
          const inspection = driver.inspectSession(remoteRaw);
          return {
            agentName,
            sessionId,
            state: inspection.state,
            reason: inspection.reason,
            messages: driver.parseSession(remoteRaw),
            source: 'remote',
          };
        }
      }
    }
  }

  return {
    agentName,
    sessionId,
    state: 'error',
    messages: [],
    reason: 'Session file not found',
  };
}

export async function headlessSession(taskId: string | undefined, deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence' | 'executionAgentRegistry' | 'invokerConfig'>): Promise<void> {
  if (!taskId) throw new Error('Usage: --headless session <taskId>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  const task = deps.orchestrator.getTask(taskId);
  if (!task) throw new Error(`Task "${taskId}" not found`);

  let sessionId = task.execution.agentSessionId ?? task.execution.lastAgentSessionId;
  let agentName = task.execution.agentName ?? task.execution.lastAgentName ?? resolveDefaultExecutionAgent(deps.invokerConfig);

  // Fallback: if current execution dropped agentSessionId, recover the most
  // recent session from task event payloads.
  if (!sessionId) {
    const events = loadAllEventsPaged(deps.persistence, taskId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const payload = events[i].payload;
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload);
        const exec = parsed?.execution;
        if (exec?.agentSessionId) {
          sessionId = String(exec.agentSessionId);
          if (exec.agentName) {
            agentName = String(exec.agentName);
          }
          writeOut(`Recovered agent session from event log: ${sessionId}\n`);
          break;
        }
      } catch {
        // Ignore malformed payload JSON
      }
    }
  }

  if (!sessionId) {
    writeOut(`No agent session for task "${taskId}"\n`);
    return;
  }

  writeOut(`agent=${agentName} sessionId=${sessionId}\n`);

  const allTasks = deps.orchestrator.getAllTasks();
  const result = await resolveAgentSession(sessionId, agentName, deps.executionAgentRegistry, allTasks);
  if (!result) {
    writeOut('Session lookup failed\n');
    return;
  }
  writeOut(`state=${result.state}${result.source ? ` source=${result.source}` : ''}\n`);
  if (result.reason) {
    writeOut(`${result.reason}\n`);
  }
  for (const msg of result.messages) {
    writeOut(`[${msg.role}] ${msg.content}\n`);
  }
}

function createHeadlessWorkerStatusSnapshot(
  deps: Pick<HeadlessQueryDeps, 'persistence' | 'invokerConfig'>,
): WorkerStatusSnapshot {
  const registry = registerExternalWorkersFromConfig(
    deps.invokerConfig?.externalWorkers,
    registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>()),
  );
  return createLocalWorkerStatusSnapshot({
    registry,
    persistence: deps.persistence,
    autoStartKinds: autoStartedOwnerWorkerKindsForConfig(deps.invokerConfig),
  });
}

function formatWorkerStatusSnapshot(snapshot: WorkerStatusSnapshot): string {
  const lines = [
    `${BOLD}Workers${RESET}`,
    `  generatedAt: ${snapshot.generatedAt}`,
    `  count: ${snapshot.workers.length}`,
  ];
  for (const worker of snapshot.workers) {
    const policy = worker.policyReason ? `${worker.policy} (${worker.policyReason})` : worker.policy;
    const source = worker.source ? ` · ${worker.source}` : '';
    const desired = worker.desiredEnabled === undefined ? '' : ` · desired=${worker.desiredEnabled}`;
    lines.push(`  - ${worker.kind}: ${renderWorkerLifecycle(worker)} · ${policy}${desired}${source}`);
  }
  return lines.join('\n');
}

type RecoveryWorkerStatusWithActions = RecoveryWorkerStatus & {
  recentActions?: WorkerActionSummary[];
};

function formatRecoveryWorkerStatus(status: RecoveryWorkerStatusWithActions): string {
  const lines = [
    `${BOLD}Recovery worker${RESET}`,
    `  kind: ${status.kind}`,
    `  workerId: ${status.workerId}`,
    `  owner: ${status.owner}`,
    `  lastWakeupAt: ${status.lastWakeupAt ?? 'never'}`,
    `  lastScanAt: ${status.lastScanAt ?? 'never'}`,
    `  lastSubmitAt: ${status.lastSubmitAt ?? 'never'}`,
    `  lastSkip: ${status.lastSkipAt ?? 'never'}${status.lastSkipReason ? ` (${status.lastSkipReason} task=${status.lastSkipTaskId})` : ''}`,
    `  counts: wakeups=${status.wakeups} scans=${status.scans} submissions=${status.submissions} skips=${status.skips}`,
  ];
  if (status.recent.length > 0) {
    lines.push('');
    lines.push(`${BOLD}Recent recovery decisions${RESET}`);
    for (const event of status.recent) {
      const reason = event.reason ? ` reason=${event.reason}` : '';
      const phase = event.phase ? ` phase=${event.phase}` : '';
      lines.push(`  ${event.at} ${event.taskId} ${event.action}${phase}${reason}`);
    }
  }
  if (status.recentActions && status.recentActions.length > 0) {
    lines.push('');
    lines.push(`${BOLD}Recent worker actions${RESET}`);
    for (const action of status.recentActions) {
      const task = action.taskId ? ` task=${action.taskId}` : '';
      const reason = action.reason ? ` reason=${action.reason}` : '';
      const summary = action.summary ? ` — ${action.summary}` : '';
      lines.push(
        `  ${action.updatedAt} ${action.workerKind}/${action.actionType} [${action.status}]${task}${reason}${summary}`,
      );
    }
  }
  return lines.join('\n');
}

export async function renderWorkerStatus(
  flagArgs: string[],
  deps: Pick<HeadlessQueryDeps, 'persistence'>,
): Promise<void> {
  const flags = parseQueryFlags(flagArgs);
  const status = collectRecoveryWorkerStatus(deps.persistence);
  const recentActions = deps.persistence.listWorkerActions?.({ workerKind: AUTO_FIX_WORKER_KIND, limit: 5 })
    .map(toWorkerActionSummary) ?? [];
  const statusWithActions: RecoveryWorkerStatusWithActions = {
    ...status,
    recentActions,
  };
  const { formatAsJson, formatAsJsonl } = await import('./formatter.js');
  switch (flags.output) {
    case 'label':
      writeOut(`${status.workerId}\n`);
      break;
    case 'json':
      writeOut(formatAsJson(statusWithActions) + '\n');
      break;
    case 'jsonl':
      writeOut(formatAsJsonl([statusWithActions]) + '\n');
      break;
    default:
      writeOut(formatRecoveryWorkerStatus(statusWithActions) + '\n');
      break;
  }
}

/**
 * Top-level read-only headless commands that the writable owner can answer on
 * behalf of a non-owner caller. Mirrors the read-command routing in
 * `headless.ts` (`runHeadless`) but needs only {@link HeadlessQueryDeps}.
 */
async function dispatchReadOnlyHeadlessQuery(args: string[], deps: HeadlessQueryDeps): Promise<void> {
  const command = args[0];
  switch (command) {
    case 'query':
      // `query ui-perf --reset` clears the owner's UI-perf stats; that is a
      // mutation, not a read, so it must never run through the delegated path.
      if (args[1] === 'ui-perf' && parseQueryFlags(args.slice(2)).reset) {
        throw new Error('query ui-perf --reset is not a delegatable read-only query');
      }
      return headlessQuery(args.slice(1), deps);
    case 'query-select':
      return headlessQuerySelect(args[1], deps);
    // Deprecated top-level aliases → canonical `query <sub>`.
    case 'list':
      return headlessQuery(['workflows', ...args.slice(1)], deps);
    case 'status':
      return headlessQuery(['tasks', ...args.slice(1)], deps);
    case 'task-status':
      return headlessQuery(['task', ...args.slice(1)], deps);
    case 'queue':
      return headlessQuery(['queue', ...args.slice(1)], deps);
    case 'audit':
      return headlessQuery(['audit', ...args.slice(1)], deps);
    case 'session':
      return headlessQuery(['session', ...args.slice(1)], deps);
    case 'worker': {
      const workerSub = args[1] ?? 'list';
      if (workerSub === 'status') {
        return renderWorkerStatus(args.slice(2), deps);
      }
      throw new Error(`worker ${workerSub} is not a delegatable read-only query`);
    }
    default:
      throw new Error(`Command "${String(command)}" is not a delegatable read-only query`);
  }
}

/**
 * Run a read-only headless command on the writable owner and capture its
 * rendered stdout instead of printing it. Used by the owner's `cli-query`
 * IPC handler so a non-owner caller never has to open the database file.
 */
export async function runReadOnlyHeadlessQueryToString(args: string[], deps: HeadlessQueryDeps): Promise<string> {
  const chunks: string[] = [];
  await queryOutputSink.run((chunk) => { chunks.push(chunk); }, () => dispatchReadOnlyHeadlessQuery(args, deps));
  return chunks.join('');
}
