import type { RunnerKind } from '@invoker/workflow-graph';

/**
 * A single routing rule that validates task pool placement against command patterns.
 * When a rule matches a task command, the orchestrator validates that the task's
 * pool destination conforms to the rule's requirements.
 */
export interface ExecutorRoutingRule {
  /** Substring to match against the task command. */
  pattern?: string;
  /** Regular expression matched against the task command; compiled with new RegExp(regex). */
  regex?: string;
  /** Required execution pool ID for matching commands. */
  poolId: string;
  /**
   * Rule behavior:
   * - enforce (default): task must already declare matching executor/destination
   * - route: auto-apply rule executor/destination when omitted, and reject conflicts
   */
  strategy?: 'enforce' | 'route';
}

export interface CommandRoutingMatcher {
  pattern?: string;
  regex?: string;
}

export interface HeavyweightCommandRoutingPolicy {
  enabled?: boolean;
  poolId: string;
  matchers?: CommandRoutingMatcher[];
}

const DEFAULT_HEAVYWEIGHT_COMMAND_MATCHERS: CommandRoutingMatcher[] = [
  { regex: '\\bpnpm(?:\\s|$)' },
];

function validateRoutingDestinationAvailability(
  taskId: string,
  command: string,
  sourceLabel: string,
  poolId: string | undefined,
  availablePoolIds: Set<string>,
): void {
  if (availablePoolIds.size > 0 && (!poolId || !availablePoolIds.has(poolId))) {
    throw new Error(
      `Task "${taskId}" with command "${command}" matched ${sourceLabel}, ` +
      `but config poolId="${poolId}" is not defined in executionPools.`,
    );
  }
  if (availablePoolIds.size === 0) {
    throw new Error(
      `Task "${taskId}" with command "${command}" matched ${sourceLabel}, ` +
      'but no executionPools are configured.',
    );
  }
}

export function buildHeavyweightRoutingRules(
  taskId: string,
  policy: HeavyweightCommandRoutingPolicy | undefined,
): ExecutorRoutingRule[] {
  if (!policy || policy.enabled === false) {
    return [];
  }

  const matchers = policy.matchers?.length ? policy.matchers : DEFAULT_HEAVYWEIGHT_COMMAND_MATCHERS;
  if (!policy.poolId) {
    throw new Error(
      `Task "${taskId}" matched heavyweight command routing, ` +
      'but config is missing destination: set poolId.',
    );
  }

  return matchers.map((matcher) => ({
    pattern: matcher.pattern,
    regex: matcher.regex,
    poolId: policy.poolId,
    strategy: 'route',
  }));
}

function applyRoutingRule(
  taskId: string,
  command: string,
  planPoolId: string | undefined,
  rule: ExecutorRoutingRule,
  sourceLabel: string,
  availablePoolIds: Set<string>,
): { poolId?: string } | undefined {
  validateRoutingDestinationAvailability(
    taskId,
    command,
    sourceLabel,
    rule.poolId,
    availablePoolIds,
  );
  if (planPoolId !== undefined && planPoolId !== rule.poolId) {
    throw new Error(
      `Task "${taskId}" with command "${command}" matched ${sourceLabel} and must use ` +
      `poolId="${rule.poolId}", but plan declares poolId="${planPoolId}"`,
    );
  }
  return {
    poolId: rule.poolId ?? planPoolId,
  };
}

/**
 * Finds the first executor routing rule that matches the given command.
 * A rule matches when `pattern` is a substring of `command`, `regex` compiles and tests
 * true against `command`, or both (either is sufficient).
 * Returns the matching rule or undefined if no rule matches.
 */
export function findMatchingExecutorRoutingRule(
  command: string,
  rules: ExecutorRoutingRule[],
): ExecutorRoutingRule | undefined {
  for (const rule of rules) {
    const patternMatch = rule.pattern !== undefined && command.includes(rule.pattern);
    const regexMatch = rule.regex !== undefined && new RegExp(rule.regex).test(command);
    if (patternMatch || regexMatch) {
      return rule;
    }
  }
  return undefined;
}

/**
 * Validates that a task's routing conforms to pool routing rules.
 * Returns immediately if the task has no command or no rules are configured.
 * When a rule matches the task command, throws if the task's poolId does not
 * match the rule's requirements.
 */
export function assertExecutorRoutingConforms(
  taskId: string,
  command: string | undefined,
  planPoolId: string | undefined,
  rules: ExecutorRoutingRule[],
): void {
  if (!command || rules.length === 0) {
    return;
  }

  const matchingRule = findMatchingExecutorRoutingRule(command, rules);
  if (!matchingRule) {
    return;
  }

  if (planPoolId !== matchingRule.poolId) {
    throw new Error(
      `Task "${taskId}" with command "${command}" requires poolId="${matchingRule.poolId}" ` +
      `but plan declares poolId="${planPoolId ?? '(undefined)'}"`
    );
  }
}

export function resolveExecutorRouting(
  taskId: string,
  command: string | undefined,
  planPoolId: string | undefined,
  defaultPoolId: string | undefined,
  rules: ExecutorRoutingRule[],
  availablePoolIds: Set<string>,
): { poolId?: string; reason: ExecutorRoutingReason } {
  if (defaultPoolId && availablePoolIds.size > 0 && !availablePoolIds.has(defaultPoolId)) {
    throw new Error(
      `Task "${taskId}" cannot use defaultPoolId="${defaultPoolId}" because it is not defined in executionPools.`,
    );
  }

  const initialPoolId = planPoolId ?? defaultPoolId;
  const initialReason: ExecutorRoutingReason = initialPoolId
    ? { type: 'poolId', poolId: initialPoolId }
    : { type: 'defaultWorktree' };

  if (!command || rules.length === 0) {
    return {
      poolId: initialPoolId,
      reason: initialReason,
    };
  }

  let effectivePoolId = initialPoolId;
  let reason: ExecutorRoutingReason = initialReason;

  const routingRules = rules.filter((rule) => (rule.strategy ?? 'enforce') === 'route');
  const matchingRoutingRule = findMatchingExecutorRoutingRule(command, routingRules);
  if (matchingRoutingRule) {
    const routed = applyRoutingRule(
      taskId,
      command,
      planPoolId,
      matchingRoutingRule,
      'routing rule',
      availablePoolIds,
    );
    effectivePoolId = routed?.poolId ?? effectivePoolId;
    if (routed?.poolId) {
      reason = {
        type: 'routingRule',
        poolId: routed.poolId,
        ...(matchingRoutingRule.pattern !== undefined ? { pattern: matchingRoutingRule.pattern } : {}),
        ...(matchingRoutingRule.regex !== undefined ? { regex: matchingRoutingRule.regex } : {}),
      };
    }
  }

  const enforcementRules = rules.filter((rule) => (rule.strategy ?? 'enforce') === 'enforce');
  assertExecutorRoutingConforms(
    taskId,
    command,
    effectivePoolId,
    enforcementRules,
  );

  return {
    poolId: effectivePoolId,
    reason,
  };
}

export type ExecutorRoutingReason =
  | { type: 'dockerImage' }
  | { type: 'poolId'; poolId: string }
  | { type: 'routingRule'; poolId: string; pattern?: string; regex?: string }
  | { type: 'defaultWorktree' };

export function buildExecutorRoutedPayload(
  runnerKind: RunnerKind,
  poolId: string | undefined,
  reason: ExecutorRoutingReason,
): Record<string, unknown> {
  return {
    runnerKind,
    ...(poolId ? { poolId } : {}),
    reason,
  };
}
