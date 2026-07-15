/**
 * Formatter — Terminal output helpers with ANSI color codes.
 *
 * No external dependencies. Uses raw ANSI escape codes for coloring.
 */

import type { TaskState, TaskStatus } from '@invoker/workflow-core';
import type { TaskEvent, WorkerActionRecord, Workflow } from '@invoker/data-store';
import type { NormalizedCostEvent, CostRollup, WorkerActionSummary } from '@invoker/contracts';
import type { GroupedCostRollup } from './cost-rollup.js';

// ── ANSI Color Codes ─────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const DIM = '\x1b[2m';


type JsonSafeValue = string | number | boolean | null | JsonSafeValue[] | { [key: string]: JsonSafeValue };

function escapeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
    switch (char) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });
}

function normalizeJsonValue(value: unknown, seen = new WeakSet<object>()): JsonSafeValue {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return null;
    case 'object':
      break;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }
  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(item => normalizeJsonValue(item, seen));
    }
    if (value instanceof Map) {
      const normalized: { [key: string]: JsonSafeValue } = {};
      for (const [key, item] of value.entries()) {
        normalized[String(key)] = normalizeJsonValue(item, seen);
      }
      return normalized;
    }
    if (value instanceof Set) {
      return Array.from(value, item => normalizeJsonValue(item, seen));
    }

    const normalized: { [key: string]: JsonSafeValue } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      normalized[key] = normalizeJsonValue(item, seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}
// ── Status Colors ────────────────────────────────────────────

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: DIM,
  running: YELLOW,
  fixing_with_ai: MAGENTA,
  completed: GREEN,
  failed: RED,
  closed: DIM,
  needs_input: BLUE,
  review_ready: CYAN,
  blocked: DIM,
  awaiting_approval: CYAN,
  stale: DIM,
};

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: '○',
  running: '●',
  fixing_with_ai: '🔧',
  completed: '✓',
  failed: '✗',
  closed: '◼',
  needs_input: '?',
  review_ready: '👀',
  blocked: '⊘',
  awaiting_approval: '⏳',
  stale: '◌',
};

// ── Public API ───────────────────────────────────────────────

/**
 * Format a single task as a colored one-line summary.
 *
 * Example: "  ✓ greet — Say hello [completed]"
 */
export function formatTaskStatus(task: TaskState): string {
  const isFixing =
    task.status === 'fixing_with_ai' ||
    (task.status === 'running' && task.execution.isFixingWithAI);
  const isFixApproval = task.status === 'awaiting_approval' && task.execution.pendingFixError;
  const color = isFixing ? MAGENTA : isFixApproval ? YELLOW : (STATUS_COLORS[task.status] ?? RESET);
  const icon = isFixing ? '🔧' : isFixApproval ? '🔧' : (STATUS_ICONS[task.status] ?? '?');
  const label = isFixing ? 'fixing_with_ai' : isFixApproval ? 'fix_approval' : task.status;
  const phaseSuffix = task.status === 'running' && task.execution.phase
    ? ` (phase=${task.execution.phase})`
    : '';
  const conflictSuffix = task.execution.mergeConflict
    ? ` ${DIM}[conflict: ${task.execution.mergeConflict.conflictFiles.join(', ')}]${RESET}`
    : '';
  return `${color}  ${icon} ${BOLD}${task.id}${RESET}${color} — ${task.description} [${label}]${phaseSuffix}${RESET}${conflictSuffix}`;
}

/**
 * Format workflow status as a summary line.
 *
 * Example: "Workflow: 3 total | 2 completed | 0 failed | 1 running | 0 pending"
 */
export function formatWorkflowStatus(status: {
  total: number;
  completed: number;
  failed: number;
  closed?: number;
  running: number;
  pending: number;
}): string {
  const parts = [
    `${BOLD}Workflow:${RESET} ${status.total} total`,
    `${GREEN}${status.completed} completed${RESET}`,
    `${RED}${status.failed} failed${RESET}`,
    `${DIM}${status.closed ?? 0} closed${RESET}`,
    `${YELLOW}${status.running} running${RESET}`,
    `${DIM}${status.pending} pending${RESET}`,
  ];
  return parts.join(' | ');
}

/**
 * Format a list of workflows as a table-like output.
 *
 * Each workflow gets one line: "  id — name [status] (created)"
 */
export function formatWorkflowList(
  workflows: Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }>,
): string {
  if (workflows.length === 0) {
    return `${DIM}No workflows found.${RESET}`;
  }

  const WORKFLOW_STATUS_COLORS: Record<string, string> = {
    running: YELLOW,
    completed: GREEN,
    failed: RED,
  };

  const lines = workflows.map((wf) => {
    const color = WORKFLOW_STATUS_COLORS[wf.status] ?? DIM;
    return `${color}  ${BOLD}${wf.id}${RESET}${color} — ${wf.name} [${wf.status}] ${DIM}(${wf.createdAt})${RESET}`;
  });

  return lines.join('\n');
}

/**
 * Format an event log as a table-like output.
 *
 * Each event gets one line: "[timestamp] taskId: eventType payload"
 */
export function formatEventLog(events: TaskEvent[]): string {
  if (events.length === 0) {
    return `${DIM}No events recorded.${RESET}`;
  }

  const lines = events.map((event) => {
    const timestamp = event.createdAt;
    const rendered = renderTaskEvent(event);
    const payload = rendered.payload ? ` ${rendered.payload}` : '';
    return `${DIM}[${timestamp}]${RESET} ${BOLD}${event.taskId}${RESET}: ${rendered.eventType}${payload}`;
  });

  return lines.join('\n');
}

function parseTaskEventPayload(payload: string | undefined): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function stringPayloadValue(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function renderTaskEvent(event: TaskEvent): { eventType: string; payload?: string } {
  if (event.eventType !== 'task.worker_action') {
    return { eventType: event.eventType, ...(event.payload ? { payload: event.payload } : {}) };
  }

  const payload = parseTaskEventPayload(event.payload);
  const workerKind = stringPayloadValue(payload, 'workerKind') ?? 'worker';
  const actionType = stringPayloadValue(payload, 'actionType') ?? 'action';
  const status = stringPayloadValue(payload, 'status') ?? 'recorded';
  const summary = stringPayloadValue(payload, 'summary');
  const reason = stringPayloadValue(payload, 'reason');
  const renderedPayload = [
    `${workerKind}/${actionType}`,
    `[${status}]`,
    ...(summary ? [summary] : []),
    ...(reason ? [`reason=${reason}`] : []),
  ].join(' ');
  return {
    eventType: 'task.worker_action',
    payload: escapeTerminalText(renderedPayload),
  };
}

export function formatWorkerActions(actions: WorkerActionRecord[]): string {
  if (actions.length === 0) {
    return `${DIM}No worker actions found.${RESET}`;
  }

  const lines: string[] = [];
  lines.push(`${BOLD}Worker actions (${actions.length})${RESET}`);
  for (const action of actions) {
    const id = escapeTerminalText(action.id);
    const workerKind = escapeTerminalText(action.workerKind);
    const actionType = escapeTerminalText(action.actionType);
    const task = action.taskId ? ` task=${escapeTerminalText(action.taskId)}` : '';
    const workflow = action.workflowId ? ` workflow=${escapeTerminalText(action.workflowId)}` : '';
    const attempts = ` attempts=${action.attemptCount}`;
    const completed = action.completedAt ? ` completed=${escapeTerminalText(action.completedAt)}` : '';
    const summary = action.summary ? ` — ${escapeTerminalText(action.summary)}` : '';
    lines.push(
      `  ${BOLD}${id}${RESET} [${action.status}] ${workerKind}/${actionType}` +
        `${workflow}${task}${attempts}${completed}${summary}`,
    );
  }
  return lines.join('\n');
}

export function formatWorkerDecisions(actions: WorkerActionSummary[]): string {
  if (actions.length === 0) {
    return `${DIM}No worker decisions found.${RESET}`;
  }

  const lines: string[] = [];
  lines.push(`${BOLD}Worker decisions (${actions.length})${RESET}`);
  for (const action of actions) {
    const decision = (action.decision ?? (action.status === 'skipped' ? 'skip' : 'act')).toUpperCase();
    const id = escapeTerminalText(action.id);
    const workerKind = escapeTerminalText(action.workerKind);
    const actionType = escapeTerminalText(action.actionType);
    const subject = action.taskId
      ? ` task=${escapeTerminalText(action.taskId)}`
      : ` ${escapeTerminalText(action.subjectType)}=${escapeTerminalText(action.subjectId)}`;
    const workflow = action.workflowId ? ` workflow=${escapeTerminalText(action.workflowId)}` : '';
    const attempts = ` attempts=${action.attemptCount}`;
    const agent = action.agentName ? ` agent=${escapeTerminalText(action.agentName)}` : '';
    const reason = action.reason ? ` reason=${escapeTerminalText(action.reason)}` : '';
    const summary = action.summary ? ` — ${escapeTerminalText(action.summary)}` : '';
    lines.push(
      `  ${BOLD}${decision}${RESET} ${BOLD}${id}${RESET} [${action.status}] ${workerKind}/${actionType}` +
        `${workflow}${subject}${attempts}${agent}${reason}${summary}`,
    );
  }
  return lines.join('\n');
}

/**
 * Format queue status showing concurrency and running/queued tasks.
 *
 * Example output:
 * ```
 * Concurrency: 2 / 3 running
 *
 * Running (2):
 *   ● task-a — Run tests
 *   ● task-b — Build frontend
 *
 * Queued (1):
 *   ○ task-c — Deploy staging [pri: 0]
 * ```
 */
export function formatQueueStatus(status: {
  maxConcurrency: number;
  runningCount: number;
  activeExecutionCount: number;
  launchingCount: number;
  running: Array<{ taskId: string; description: string }>;
  queued: Array<{ taskId: string; priority: number; description: string }>;
}): string {
  const lines: string[] = [];

  // Concurrency header
  lines.push(
    `${BOLD}Concurrency:${RESET} running=${status.activeExecutionCount} launching=${status.launchingCount} slots=${status.runningCount}/${status.maxConcurrency} queued=${status.queued.length}`,
  );
  lines.push('');

  lines.push(`${BOLD}${YELLOW}Active slots (${status.running.length}):${RESET}`);
  if (status.running.length === 0) {
    lines.push(`${DIM}  (none)${RESET}`);
  } else {
    for (const task of status.running) {
      lines.push(
        `${YELLOW}  ● ${BOLD}${task.taskId}${RESET}${YELLOW} — ${task.description}${RESET}`,
      );
    }
  }
  lines.push('');

  // Queued section
  lines.push(`${BOLD}${CYAN}Queued (${status.queued.length}):${RESET}`);
  if (status.queued.length === 0) {
    lines.push(`${DIM}  (none)${RESET}`);
  } else {
    for (const task of status.queued) {
      lines.push(
        `${CYAN}  ○ ${BOLD}${task.taskId}${RESET}${CYAN} — ${task.description} ${DIM}[pri: ${task.priority}]${RESET}`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Format aggregate stats across all workflows.
 */
export function formatWorkflowStats(stats: {
  totalWorkflows: number;
  completed: number;
  failed: number;
  running: number;
  successRate: number;
  avgDurationMs: number | null;
  mostFailedTasks: Array<{ description: string; failCount: number }>;
}): string {
  const lines: string[] = [];

  lines.push(`${BOLD}Workflow stats${RESET}`);
  lines.push('');
  lines.push(`  Total      ${BOLD}${stats.totalWorkflows}${RESET}`);
  lines.push(`  ${GREEN}Completed  ${stats.completed}${RESET}`);
  lines.push(`  ${RED}Failed     ${stats.failed}${RESET}`);
  lines.push(`  ${YELLOW}Running    ${stats.running}${RESET}`);
  lines.push(`  Success    ${BOLD}${stats.successRate.toFixed(1)}%${RESET}`);

  if (stats.avgDurationMs !== null) {
    const secs = Math.round(stats.avgDurationMs / 1000);
    const avg = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
    lines.push(`  Avg time   ${BOLD}${avg}${RESET}`);
  }

  if (stats.mostFailedTasks.length > 0) {
    lines.push('');
    lines.push(`${BOLD}Most failed tasks:${RESET}`);
    for (const t of stats.mostFailedTasks) {
      lines.push(`  ${RED}${t.failCount}x${RESET}  ${t.description}`);
    }
  }

  return lines.join('\n');
}

// ── Output Format Type ──────────────────────────────────────

export type OutputFormat = 'text' | 'label' | 'json' | 'jsonl';

// ── Serializers ─────────────────────────────────────────────

/**
 * Convert a Workflow to a plain JSON-safe object.
 * All Date-like fields are kept as ISO strings (already strings from DB).
 */
export function serializeWorkflow(wf: Workflow): Record<string, unknown> {
  return {
    id: wf.id,
    name: wf.name,
    status: wf.status,
    createdAt: wf.createdAt,
    updatedAt: wf.updatedAt,
    ...(wf.description != null && { description: wf.description }),
    ...(wf.visualProof != null && { visualProof: wf.visualProof }),
    ...(wf.planFile != null && { planFile: wf.planFile }),
    ...(wf.repoUrl != null && { repoUrl: wf.repoUrl }),
    ...(wf.branch != null && { branch: wf.branch }),
    ...(wf.onFinish != null && { onFinish: wf.onFinish }),
    ...(wf.baseBranch != null && { baseBranch: wf.baseBranch }),
    ...(wf.featureBranch != null && { featureBranch: wf.featureBranch }),
    ...(wf.mergeMode != null && { mergeMode: wf.mergeMode }),
    ...(wf.reviewProvider != null && { reviewProvider: wf.reviewProvider }),
    ...(wf.externalDependencies != null && { externalDependencies: wf.externalDependencies }),
    ...(wf.externalDependencyChanges != null && { externalDependencyChanges: wf.externalDependencyChanges }),
    ...(wf.detachedExternalDependencies != null && { detachedExternalDependencies: wf.detachedExternalDependencies }),
    ...(wf.generation != null && { generation: wf.generation }),
  };
}

/**
 * Convert a TaskState to a plain JSON-safe object with config/execution subsets.
 * Dates are converted to ISO strings.
 */
export function serializeTask(task: TaskState): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (task.config.workflowId != null) config.workflowId = task.config.workflowId;
  if (task.config.command != null) config.command = task.config.command;
  if (task.config.prompt != null) config.prompt = task.config.prompt;
  if (task.config.runnerKind != null) config.runnerKind = task.config.runnerKind;
  if (task.config.poolId != null) config.poolId = task.config.poolId;
  if (task.config.poolMemberId != null) config.poolMemberId = task.config.poolMemberId;
  if (task.config.isMergeNode != null) config.isMergeNode = task.config.isMergeNode;
  if (task.config.executionAgent != null) config.executionAgent = task.config.executionAgent;
  if (task.config.executionModel != null) config.executionModel = task.config.executionModel;
  if (task.config.featureBranch != null) config.featureBranch = task.config.featureBranch;

  const execution: Record<string, unknown> = {};
  if (task.execution.branch != null) execution.branch = task.execution.branch;
  if (task.execution.commit != null) execution.commit = task.execution.commit;
  if (task.execution.error != null) execution.error = task.execution.error;
  if (task.execution.exitCode != null) execution.exitCode = task.execution.exitCode;
  if (task.execution.reviewUrl != null) execution.reviewUrl = task.execution.reviewUrl;
  if (task.execution.reviewId != null) execution.reviewId = task.execution.reviewId;
  if (task.execution.reviewStatus != null) execution.reviewStatus = task.execution.reviewStatus;
  if (task.execution.reviewProviderId != null) execution.reviewProviderId = task.execution.reviewProviderId;
  if (task.execution.reviewGate != null) execution.reviewGate = task.execution.reviewGate;
  if (task.execution.agentSessionId != null) execution.agentSessionId = task.execution.agentSessionId;
  if (task.execution.lastAgentSessionId != null) execution.lastAgentSessionId = task.execution.lastAgentSessionId;
  if (task.execution.agentName != null) execution.agentName = task.execution.agentName;
  if (task.execution.lastAgentName != null) execution.lastAgentName = task.execution.lastAgentName;
  if (task.execution.phase != null) execution.phase = task.execution.phase;
  if (task.execution.startedAt != null) execution.startedAt = task.execution.startedAt instanceof Date ? task.execution.startedAt.toISOString() : task.execution.startedAt;
  if (task.execution.completedAt != null) execution.completedAt = task.execution.completedAt instanceof Date ? task.execution.completedAt.toISOString() : task.execution.completedAt;
  if (task.execution.launchStartedAt != null) execution.launchStartedAt = task.execution.launchStartedAt instanceof Date ? task.execution.launchStartedAt.toISOString() : task.execution.launchStartedAt;
  if (task.execution.launchCompletedAt != null) execution.launchCompletedAt = task.execution.launchCompletedAt instanceof Date ? task.execution.launchCompletedAt.toISOString() : task.execution.launchCompletedAt;
  if (task.execution.lastHeartbeatAt != null) execution.lastHeartbeatAt = task.execution.lastHeartbeatAt instanceof Date ? task.execution.lastHeartbeatAt.toISOString() : task.execution.lastHeartbeatAt;
  if (task.execution.pendingFixError != null) execution.pendingFixError = task.execution.pendingFixError;
  if (task.execution.mergeConflict != null) {
    execution.mergeConflict = {
      failedBranch: task.execution.mergeConflict.failedBranch,
      conflictFiles: [...task.execution.mergeConflict.conflictFiles],
    };
  }

  return {
    id: task.id,
    description: task.description,
    status: task.status,
    dependencies: [...task.dependencies],
    createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
    config,
    execution,
  };
}

/**
 * Convert a TaskEvent to a plain JSON-safe object.
 */
export function serializeEvent(event: TaskEvent): Record<string, unknown> {
  return {
    id: event.id,
    taskId: event.taskId,
    eventType: event.eventType,
    ...(event.payload != null && { payload: event.payload }),
    createdAt: event.createdAt,
  };
}

export function serializeWorkerAction(action: WorkerActionRecord): Record<string, unknown> {
  return {
    id: action.id,
    workerKind: action.workerKind,
    actionType: action.actionType,
    ...(action.workflowId != null && { workflowId: action.workflowId }),
    ...(action.taskId != null && { taskId: action.taskId }),
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    externalKey: action.externalKey,
    status: action.status,
    attemptCount: action.attemptCount,
    ...(action.intentId != null && { intentId: action.intentId }),
    ...(action.agentName != null && { agentName: action.agentName }),
    ...(action.executionModel != null && { executionModel: action.executionModel }),
    ...(action.sessionId != null && { sessionId: action.sessionId }),
    ...(action.summary != null && { summary: action.summary }),
    ...(action.payload !== undefined && { payload: normalizeJsonValue(action.payload) }),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt != null && { completedAt: action.completedAt }),
  };
}

// ── Format Emitters ─────────────────────────────────────────

/**
 * One ID per line, no decoration. For piping to xargs/while-read.
 */
export function formatAsLabel(items: Array<{ id: string }>): string {
  return items.map(item => item.id).join('\n');
}

/**
 * Compact JSON array.
 */
export function formatAsJson(data: unknown): string {
  return JSON.stringify(data);
}

/**
 * One JSON object per line (NDJSON). For streaming and large result sets.
 */
export function formatAsJsonl(items: unknown[]): string {
  return items.map(item => JSON.stringify(item)).join('\n');
}

// ── Cost Formatters ─────────────────────────────────────────

/**
 * Format a single cost event as a one-line summary.
 *
 * Example: "  claude (anthropic) — task-a — 1,200 tokens — $0.0036 [exact]"
 */
export function formatCostEvent(event: NormalizedCostEvent): string {
  const tokens = event.usage.totalTokens.toLocaleString();
  const cost = `$${event.pricing.estimatedCostUsd.toFixed(4)}`;
  const conf = event.pricing.confidence;
  const confColor = conf === 'exact' ? GREEN : conf === 'estimated' ? YELLOW : RED;
  return `${DIM}  ${event.identity.agentName}${RESET} (${event.identity.source}) — ${BOLD}${event.attribution.taskId}${RESET} — ${tokens} tokens — ${confColor}${cost} [${conf}]${RESET}`;
}

/**
 * Format a cost rollup as a summary block.
 */
export function formatCostRollup(rollup: CostRollup): string {
  const lines: string[] = [];
  lines.push(`${BOLD}Cost summary${RESET}`);
  lines.push('');
  lines.push(`  Events       ${BOLD}${rollup.eventCount}${RESET}`);
  lines.push(`  Input        ${rollup.inputTokens.toLocaleString()} tokens`);
  lines.push(`  Output       ${rollup.outputTokens.toLocaleString()} tokens`);
  lines.push(`  Cached       ${rollup.cachedTokens.toLocaleString()} tokens`);
  lines.push(`  Total        ${BOLD}${rollup.totalTokens.toLocaleString()}${RESET} tokens`);
  lines.push(`  Cost         ${BOLD}$${rollup.totalCostUsd.toFixed(4)}${RESET}`);

  if (rollup.unknownConfidenceCount > 0) {
    lines.push(`  ${YELLOW}Unknown confidence  ${rollup.unknownConfidenceCount}${RESET}`);
  }
  if (rollup.missingUsageCount > 0) {
    lines.push(`  ${RED}Missing usage       ${rollup.missingUsageCount}${RESET}`);
  }

  return lines.join('\n');
}

/**
 * Format grouped cost rollups as a table-like block.
 *
 * Each group gets a header line with dimension values, followed by
 * a compact rollup summary.
 */
export function formatGroupedCostRollups(groups: GroupedCostRollup[]): string {
  if (groups.length === 0) {
    return `${DIM}No cost data available.${RESET}`;
  }

  const lines: string[] = [];
  lines.push(`${BOLD}Cost rollup (${groups.length} group${groups.length === 1 ? '' : 's'})${RESET}`);
  lines.push('');

  for (const group of groups) {
    const dimParts = Object.entries(group.dimensions)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const r = group.rollup;
    const cost = `$${r.totalCostUsd.toFixed(4)}`;
    const warnings: string[] = [];
    if (r.unknownConfidenceCount > 0) warnings.push(`${YELLOW}${r.unknownConfidenceCount} unknown${RESET}`);
    if (r.missingUsageCount > 0) warnings.push(`${RED}${r.missingUsageCount} missing${RESET}`);
    const warnSuffix = warnings.length > 0 ? ` (${warnings.join(', ')})` : '';

    lines.push(`  ${BOLD}${dimParts}${RESET}`);
    lines.push(`    ${r.eventCount} events — ${r.totalTokens.toLocaleString()} tokens — ${BOLD}${cost}${RESET}${warnSuffix}`);
  }

  return lines.join('\n');
}

/**
 * Serialize a NormalizedCostEvent to a plain JSON-safe object.
 */
export function serializeCostEvent(event: NormalizedCostEvent): Record<string, unknown> {
  return {
    eventId: event.identity.eventId,
    agentSessionId: event.identity.agentSessionId,
    agentName: event.identity.agentName,
    source: event.identity.source,
    workflowId: event.attribution.workflowId,
    taskId: event.attribution.taskId,
    attemptId: event.attribution.attemptId,
    runnerKind: event.attribution.runnerKind,
    inputTokens: event.usage.inputTokens,
    outputTokens: event.usage.outputTokens,
    cachedTokens: event.usage.cachedTokens,
    totalTokens: event.usage.totalTokens,
    model: event.pricing.model,
    pricingVersion: event.pricing.pricingVersion,
    estimatedCostUsd: event.pricing.estimatedCostUsd,
    confidence: event.pricing.confidence,
    timestamp: event.timestamp,
  };
}
