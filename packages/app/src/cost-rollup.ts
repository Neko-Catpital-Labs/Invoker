/**
 * Cost Rollup — Pure attribution joins and deterministic grouped aggregation.
 *
 * Takes session-local usage events and attaches workflow/task/attempt context,
 * then groups and rolls up by configurable dimensions.
 *
 * All functions are pure: no I/O, no side-effects, deterministic output order.
 */

import type { NormalizedCostEvent, CostRollup } from '@invoker/contracts';
import { rollUpCostEvents } from '@invoker/contracts';
import { DEFAULT_EXECUTION_AGENT, type SessionUsageEvent } from '@invoker/execution-engine';

// ── Attribution Context ────────────────────────────────────

/** Context needed to attribute session usage events to a workflow/task. */
export interface AttributionContext {
  readonly workflowId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly runnerKind: string;
  readonly agentSessionId: string;
  readonly agentName: string;
  readonly source: string;
}

// ── Attribution Join ───────────────────────────────────────

/**
 * Map session-local usage events to fully-attributed NormalizedCostEvents.
 *
 * Each SessionUsageEvent carries only session-scoped data (tokens, model, confidence).
 * This function attaches the workflow/task/attempt context from the caller.
 */
export function attributeSessionUsage(
  events: readonly SessionUsageEvent[],
  ctx: AttributionContext,
): NormalizedCostEvent[] {
  return events.map((e) => ({
    identity: {
      eventId: e.eventId,
      agentSessionId: ctx.agentSessionId,
      agentName: ctx.agentName,
      source: ctx.source,
    },
    attribution: {
      workflowId: ctx.workflowId,
      taskId: ctx.taskId,
      attemptId: ctx.attemptId,
      runnerKind: ctx.runnerKind,
    },
    usage: {
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cachedTokens: e.cachedTokens,
      totalTokens: e.totalTokens,
    },
    pricing: {
      model: e.model || 'unknown',
      pricingVersion: '0',
      estimatedCostUsd: 0,
      confidence: e.confidence,
    },
    timestamp: e.timestamp,
  }));
}

// ── Grouping Dimensions ────────────────────────────────────

/** Supported group-by dimensions. */
export type CostGroupDimension = 'workflow' | 'task' | 'agent' | 'model' | 'day';

/** All supported dimensions for reference. */
export const ALL_DIMENSIONS: readonly CostGroupDimension[] = [
  'workflow', 'task', 'agent', 'model', 'day',
] as const;

/** Extract a group key value from an event for a given dimension. */
function dimensionKey(event: NormalizedCostEvent, dim: CostGroupDimension): string {
  switch (dim) {
    case 'workflow': return event.attribution.workflowId;
    case 'task':     return event.attribution.taskId;
    case 'agent':    return event.identity.agentName;
    case 'model':    return event.pricing.model;
    case 'day':      return event.timestamp.slice(0, 10) || 'unknown';
  }
}

// ── Grouped Rollup ─────────────────────────────────────────

/** A single entry in the grouped rollup output. */
export interface GroupedCostRollup {
  /** The composite group key (e.g. "wf-1|task-a|claude"). */
  readonly groupKey: string;
  /** Individual dimension values in the same order as the dimensions array. */
  readonly dimensions: Record<CostGroupDimension, string>;
  /** Aggregated rollup for this group. */
  readonly rollup: CostRollup;
}

/**
 * Group events by the specified dimensions and produce deterministic rollups.
 *
 * Output is sorted by composite group key (lexicographic) so repeated runs
 * produce identical ordering. Within each group, events are rolled up using
 * the standard immutable accumulator from @invoker/contracts.
 *
 * @param events - Normalized cost events to group.
 * @param dimensions - Dimensions to group by (default: all).
 * @returns Sorted array of grouped rollups.
 */
export function groupCostEvents(
  events: readonly NormalizedCostEvent[],
  dimensions: readonly CostGroupDimension[] = ALL_DIMENSIONS,
): GroupedCostRollup[] {
  // Build groups
  const groups = new Map<string, { dims: Record<CostGroupDimension, string>; events: NormalizedCostEvent[] }>();

  for (const event of events) {
    const keyParts: string[] = [];
    const dims = {} as Record<CostGroupDimension, string>;
    for (const dim of dimensions) {
      const val = dimensionKey(event, dim);
      dims[dim] = val;
      keyParts.push(val);
    }
    const compositeKey = keyParts.join('|');

    let group = groups.get(compositeKey);
    if (!group) {
      group = { dims, events: [] };
      groups.set(compositeKey, group);
    }
    group.events.push(event);
  }

  // Sort by composite key for deterministic output
  const sortedKeys = [...groups.keys()].sort();

  return sortedKeys.map((key) => {
    const group = groups.get(key)!;
    return {
      groupKey: key,
      dimensions: group.dims,
      rollup: rollUpCostEvents(group.events),
    };
  });
}

// ── Convenience: collect events for all tasks in a workflow ─

/** Minimal task shape needed for cost extraction. */
export interface CostTaskInfo {
  readonly id: string;
  readonly workflowId: string;
  readonly runnerKind: string;
  readonly agentSessionId?: string;
  readonly lastAgentSessionId?: string;
  readonly agentName?: string;
  readonly lastAgentName?: string;
}

/**
 * Resolve session ID with deterministic fallback:
 * 1. agentSessionId (current execution)
 * 2. lastAgentSessionId (previous execution)
 * Returns undefined if neither is available.
 */
export function resolveSessionId(task: CostTaskInfo): string | undefined {
  return task.agentSessionId ?? task.lastAgentSessionId ?? undefined;
}

/**
 * Resolve agent name with deterministic fallback:
 * 1. agentName (current execution)
 * 2. lastAgentName (previous execution)
 * 3. 'claude' (default)
 */
export function resolveAgentName(task: CostTaskInfo): string {
  return task.agentName ?? task.lastAgentName ?? DEFAULT_EXECUTION_AGENT;
}

/**
 * Derive the provider source from agent name.
 * Maps known agents to their provider; defaults to 'unknown'.
 */
export function deriveSource(agentName: string): string {
  switch (agentName) {
    case 'claude': return 'anthropic';
    case 'codex':  return 'openai';
    default:       return 'unknown';
  }
}

/**
 * Build an AttributionContext from a task info record plus a caller-selected attempt ID.
 * Returns undefined if no session ID is available.
 */
export function buildAttributionContext(
  task: CostTaskInfo,
  attemptId: string,
  sessionId: string | undefined = resolveSessionId(task),
): AttributionContext | undefined {
  if (!attemptId) return undefined;
  if (!sessionId) return undefined;

  const agentName = resolveAgentName(task);
  return {
    workflowId: task.workflowId,
    taskId: task.id,
    attemptId,
    runnerKind: task.runnerKind || 'worktree',
    agentSessionId: sessionId,
    agentName,
    source: deriveSource(agentName),
  };
}

/**
 * Serialize a GroupedCostRollup to a plain JSON-safe object.
 */
export function serializeGroupedRollup(group: GroupedCostRollup): Record<string, unknown> {
  return {
    groupKey: group.groupKey,
    dimensions: { ...group.dimensions },
    ...group.rollup,
  };
}
