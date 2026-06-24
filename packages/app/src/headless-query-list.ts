/**
 * Headless "query" command family: the read-only `query <sub>` router
 * (workflows · tasks · task · queue · action-graph · audit · session · cost ·
 * cost-events · costs · ui-perf · stats), the cost-event collection/rollup
 * helpers, agent session resolution, and `query-select`.
 *
 * The deprecated top-level aliases (`list`, `status`, `task-status`, `queue`,
 * `audit`, `session`) route here through the `headless.ts` router. This
 * module depends only on `headless-shared.ts`.
 */

import type { Attempt, TaskState } from '@invoker/workflow-core';
import type { AgentSessionData, NormalizedCostEvent } from '@invoker/contracts';
import type { AgentRegistry } from '@invoker/execution-engine';
import type { CostGroupDimension } from './cost-rollup.js';
import { buildCurrentActionGraphSnapshot } from './action-graph-snapshot.js';
import {
  type HeadlessDeps,
  type QueryFlags,
  parseQueryFlags,
  restoreWorkflowForTask,
} from './headless-shared.js';

export async function headlessQuery(args: string[], deps: HeadlessDeps): Promise<void> {
  const subCommand = args[0];
  if (!subCommand) {
    throw new Error('Missing query sub-command. Usage: --headless query <workflows|tasks|task|queue|action-graph|audit|session|cost|cost-events|costs|ui-perf|stats>');
  }
  const flags = parseQueryFlags(args.slice(1));

  const {
    formatWorkflowList, formatTaskStatus, formatWorkflowStatus,
    formatEventLog, formatQueueStatus, formatWorkflowStats,
    serializeWorkflow, serializeTask, serializeEvent,
    formatAsLabel, formatAsJson, formatAsJsonl,
  } = await import('./formatter.js');

  switch (subCommand) {
    case 'workflows': {
      let workflows = deps.persistence.listWorkflows();
      if (flags.status) {
        workflows = workflows.filter(wf => wf.status === flags.status);
      }
      switch (flags.output) {
        case 'label': process.stdout.write(formatAsLabel(workflows) + '\n'); break;
        case 'json':  process.stdout.write(formatAsJson(workflows.map(serializeWorkflow)) + '\n'); break;
        case 'jsonl': process.stdout.write(formatAsJsonl(workflows.map(serializeWorkflow)) + '\n'); break;
        default:      process.stdout.write(formatWorkflowList(workflows) + '\n'); break;
      }
      break;
    }
    case 'workflow': {
      const workflowId = flags.positional[0];
      if (!workflowId) throw new Error('Missing workflowId. Usage: --headless query workflow <workflowId>');
      const workflow = deps.persistence.loadWorkflow(workflowId);
      if (!workflow) throw new Error(`Workflow "${workflowId}" not found.`);
      switch (flags.output) {
        case 'label': process.stdout.write(`${workflow.id}\n`); break;
        case 'json':  process.stdout.write(formatAsJson(serializeWorkflow(workflow)) + '\n'); break;
        case 'jsonl': process.stdout.write(formatAsJsonl([serializeWorkflow(workflow)]) + '\n'); break;
        default:      process.stdout.write(formatWorkflowList([workflow]) + '\n'); break;
      }
      break;
    }
    case 'tasks': {
      const { orchestrator, persistence } = deps;
      const workflows = persistence.listWorkflows();
      if (workflows.length === 0) {
        process.stdout.write('No workflows found. Run a plan first.\n');
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
        case 'label': process.stdout.write(formatAsLabel(allTasks) + '\n'); break;
        case 'json':  process.stdout.write(formatAsJson(allTasks.map(serializeTask)) + '\n'); break;
        case 'jsonl': process.stdout.write(formatAsJsonl(allTasks.map(serializeTask)) + '\n'); break;
        default: {
          for (const task of allTasks) process.stdout.write(formatTaskStatus(task) + '\n');
          const status = orchestrator.getWorkflowStatus();
          process.stdout.write(`\n${formatWorkflowStatus(status)}\n`);
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
        case 'label': process.stdout.write(task.id + '\n'); break;
        case 'json':  process.stdout.write(formatAsJson(serializeTask(task)) + '\n'); break;
        case 'jsonl': process.stdout.write(formatAsJsonl([serializeTask(task)]) + '\n'); break;
        default:      process.stdout.write(task.status + '\n'); break;
      }
      break;
    }
    case 'queue': {
      const workflows = deps.persistence.listWorkflows();
      for (const workflow of workflows) {
        deps.orchestrator.syncFromDb(workflow.id);
      }
      const status = deps.orchestrator.getQueueStatus();

      switch (flags.output) {
        case 'label': {
          const ids = [...status.running.map(t => t.taskId), ...status.queued.map(t => t.taskId)];
          process.stdout.write(ids.join('\n') + '\n');
          break;
        }
        case 'json':  process.stdout.write(formatAsJson(status) + '\n'); break;
        case 'jsonl': {
          for (const t of status.running) process.stdout.write(JSON.stringify({ ...t, state: 'running' }) + '\n');
          for (const t of status.queued) process.stdout.write(JSON.stringify({ ...t, state: 'queued' }) + '\n');
          break;
        }
        default: process.stdout.write(formatQueueStatus(status) + '\n'); break;
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
          process.stdout.write(graph.nodes.map((node) => node.id).join('\n') + '\n');
          break;
        case 'jsonl':
          for (const node of graph.nodes) {
            process.stdout.write(JSON.stringify({ kind: 'node', ...node }) + '\n');
          }
          for (const edge of graph.edges) {
            process.stdout.write(JSON.stringify({ kind: 'edge', ...edge }) + '\n');
          }
          break;
        case 'json':
        default:
          process.stdout.write(formatAsJson(graph) + '\n');
          break;
      }
      break;
    }
    case 'audit': {
      const taskId = flags.positional[0];
      if (!taskId) throw new Error('Usage: --headless query audit <taskId>');
      const events = deps.persistence.getEvents(taskId);

      switch (flags.output) {
        case 'label': process.stdout.write(events.map(e => `${e.taskId}:${e.eventType}`).join('\n') + '\n'); break;
        case 'json':  process.stdout.write(formatAsJson(events.map(serializeEvent)) + '\n'); break;
        case 'jsonl': process.stdout.write(formatAsJsonl(events.map(serializeEvent)) + '\n'); break;
        default:      process.stdout.write(formatEventLog(events) + '\n'); break;
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
        rendererReports: 0,
        maxRendererEventLoopLagMs: 0,
        maxRendererLongTaskMs: 0,
      };
      switch (flags.output) {
        case 'label':
          process.stdout.write(String((stats as Record<string, unknown>).maxRendererEventLoopLagMs ?? 0) + '\n');
          break;
        case 'json':
          process.stdout.write(formatAsJson(stats) + '\n');
          break;
        case 'jsonl':
          process.stdout.write(formatAsJsonl([stats]) + '\n');
          break;
        default:
          process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
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
        case 'label': process.stdout.write(`${successRate.toFixed(1)}%\n`); break;
        case 'json':  process.stdout.write(formatAsJson(stats) + '\n'); break;
        case 'jsonl': process.stdout.write(formatAsJsonl([stats]) + '\n'); break;
        default:      process.stdout.write(formatWorkflowStats(stats) + '\n'); break;
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
    default:
      throw new Error(`Unknown query sub-command: "${subCommand}". Use: workflows, tasks, task, queue, action-graph, audit, session, cost, cost-events, costs, ui-perf, stats`);
  }
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
    process.stdout.write('No cost data available.\n');
    return;
  }

  // Group by all dimensions and output
  const grouped = groupCostEvents(allEvents);
  const totalRollup = rollUpCostEvents(allEvents);

  switch (flags.output) {
    case 'label':
      process.stdout.write(`${totalRollup.totalTokens} tokens $${totalRollup.totalCostUsd.toFixed(4)}\n`);
      break;
    case 'json':
      process.stdout.write(formatAsJson({
        groups: grouped.map(serializeGroupedRollup),
        total: totalRollup,
        events: allEvents.map(serializeCostEvent),
      }) + '\n');
      break;
    case 'jsonl':
      for (const event of allEvents) {
        process.stdout.write(JSON.stringify(serializeCostEvent(event)) + '\n');
      }
      break;
    default:
      process.stdout.write(formatGroupedCostRollups(grouped) + '\n');
      process.stdout.write('\n');
      process.stdout.write(formatCostRollup(totalRollup) + '\n');
      break;
  }
}

type CostQueryDeps = Pick<HeadlessDeps, 'orchestrator' | 'persistence' | 'executionAgentRegistry'>;

function resolveCostAttributionAttempt(
  task: TaskState,
  attempts: readonly Attempt[],
): Attempt | undefined {
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
      const attempts = deps.persistence.loadAttempts(task.id);
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
    process.stdout.write('No cost data available.\n');
    return;
  }

  const grouped = groupCostEvents(allEvents, dimensions);
  const totals = rollUpCostEvents(allEvents);
  const scope = flags.workflow ?? flags.positional[0] ?? 'all';
  const groupBy = dimensions ?? [...VALID_GROUP_DIMENSIONS];

  switch (flags.output) {
    case 'label':
      process.stdout.write(`${totals.totalTokens} tokens $${totals.totalCostUsd.toFixed(4)}\n`);
      break;
    case 'json':
      process.stdout.write(formatAsJson({
        scope,
        groupBy,
        totals,
        groups: grouped.map(serializeGroupedRollup),
        metadata: { eventCount: allEvents.length },
      }) + '\n');
      break;
    case 'jsonl':
      for (const group of grouped) {
        process.stdout.write(JSON.stringify(serializeGroupedRollup(group)) + '\n');
      }
      break;
    default:
      process.stdout.write(formatGroupedCostRollups(grouped) + '\n');
      process.stdout.write('\n');
      process.stdout.write(formatCostRollup(totals) + '\n');
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
    process.stdout.write('No cost events found.\n');
    return;
  }

  switch (flags.output) {
    case 'label':
      for (const event of allEvents) {
        process.stdout.write(`${event.attribution.taskId}:${event.identity.eventId}\n`);
      }
      break;
    case 'json':
      process.stdout.write(formatAsJson(allEvents.map(serializeCostEvent)) + '\n');
      break;
    case 'jsonl':
      process.stdout.write(formatAsJsonl(allEvents.map(serializeCostEvent)) + '\n');
      break;
    default:
      for (const event of allEvents) {
        process.stdout.write(formatCostEvent(event) + '\n');
      }
      break;
  }
}

export async function headlessQuerySelect(taskId: string, deps: Pick<HeadlessDeps, 'persistence'>): Promise<void> {
  if (!taskId) throw new Error('Missing taskId.');
  const selected = deps.persistence.getSelectedExperiment(taskId);
  process.stdout.write((selected
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

export async function headlessSession(taskId: string | undefined, deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence' | 'executionAgentRegistry'>): Promise<void> {
  if (!taskId) throw new Error('Usage: --headless session <taskId>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  const task = deps.orchestrator.getTask(taskId);
  if (!task) throw new Error(`Task "${taskId}" not found`);

  let sessionId = task.execution.agentSessionId ?? task.execution.lastAgentSessionId;
  let agentName = task.execution.agentName ?? task.execution.lastAgentName ?? 'claude';

  // Fallback: if current execution dropped agentSessionId, recover the most
  // recent session from task event payloads.
  if (!sessionId) {
    const events = deps.persistence.getEvents(taskId) ?? [];
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
          process.stdout.write(`Recovered agent session from event log: ${sessionId}\n`);
          break;
        }
      } catch {
        // Ignore malformed payload JSON
      }
    }
  }

  if (!sessionId) {
    process.stdout.write(`No agent session for task "${taskId}"\n`);
    return;
  }

  process.stdout.write(`agent=${agentName} sessionId=${sessionId}\n`);

  const allTasks = deps.orchestrator.getAllTasks();
  const result = await resolveAgentSession(sessionId, agentName, deps.executionAgentRegistry, allTasks);
  if (!result) {
    process.stdout.write('Session lookup failed\n');
    return;
  }
  process.stdout.write(`state=${result.state}${result.source ? ` source=${result.source}` : ''}\n`);
  if (result.reason) {
    process.stdout.write(`${result.reason}\n`);
  }
  for (const msg of result.messages) {
    process.stdout.write(`[${msg.role}] ${msg.content}\n`);
  }
}
