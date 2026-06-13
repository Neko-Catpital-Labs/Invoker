import type { TaskExecution, TaskStateChanges } from '@invoker/workflow-graph';

export const TASK_RESET_KINDS = [
  'recreate',
  'detach',
  'retryTask',
  'retryWorkflow',
  'newAttempt',
  'defer',
  'readyUnblock',
  'externalUnblock',
] as const;

export type TaskResetKind = (typeof TASK_RESET_KINDS)[number];

type ResetRule = 'preserve' | 'clear' | 'false' | 'zero';
type TaskExecutionResetRulebook = Record<keyof TaskExecution, Record<TaskResetKind, ResetRule>>;

const preserve = {
  recreate: 'preserve',
  detach: 'preserve',
  retryTask: 'preserve',
  retryWorkflow: 'preserve',
  newAttempt: 'preserve',
  defer: 'preserve',
  readyUnblock: 'preserve',
  externalUnblock: 'preserve',
} as const satisfies Record<TaskResetKind, ResetRule>;

const clearFor = (kinds: readonly TaskResetKind[]) => {
  const rules: Record<TaskResetKind, ResetRule> = { ...preserve };
  for (const kind of kinds) rules[kind] = 'clear';
  return rules;
};

const falseFor = (kinds: readonly TaskResetKind[]) => {
  const rules: Record<TaskResetKind, ResetRule> = { ...preserve };
  for (const kind of kinds) rules[kind] = 'false';
  return rules;
};

const zeroFor = (kinds: readonly TaskResetKind[]) => {
  const rules: Record<TaskResetKind, ResetRule> = { ...preserve };
  for (const kind of kinds) rules[kind] = 'zero';
  return rules;
};

const recreateDetachNewAttempt = ['recreate', 'detach', 'newAttempt'] as const;
const retryRecreateDetachNewAttempt = ['recreate', 'detach', 'retryTask', 'retryWorkflow', 'newAttempt'] as const;
const launchReset = ['recreate', 'detach', 'retryTask', 'retryWorkflow', 'newAttempt', 'defer', 'readyUnblock', 'externalUnblock'] as const;
const detachOnly = ['detach'] as const;

export const TASK_EXECUTION_RESET_RULES = {
  generation: preserve,
  blockedBy: clearFor(['detach', 'externalUnblock']),
  inputPrompt: clearFor(['detach', 'newAttempt']),
  exitCode: clearFor(retryRecreateDetachNewAttempt),
  error: clearFor(retryRecreateDetachNewAttempt),
  protocolErrorCode: preserve,
  protocolErrorMessage: preserve,
  startedAt: clearFor(launchReset),
  completedAt: clearFor(['recreate', 'detach', 'retryTask', 'retryWorkflow', 'newAttempt', 'readyUnblock', 'externalUnblock']),
  lastHeartbeatAt: clearFor(['recreate', 'detach', 'retryTask', 'newAttempt', 'defer', 'readyUnblock', 'externalUnblock']),
  remoteHeartbeatAt: preserve,
  heartbeatSource: preserve,
  actionRequestId: preserve,
  branch: clearFor(recreateDetachNewAttempt),
  commit: clearFor(['recreate', 'detach', 'retryTask', 'newAttempt']),
  fixedIntegrationSha: clearFor(detachOnly),
  fixedIntegrationRecordedAt: clearFor(detachOnly),
  fixedIntegrationSource: clearFor(detachOnly),
  agentSessionId: clearFor(['recreate', 'detach', 'retryTask', 'newAttempt']),
  lastAgentSessionId: preserve,
  agentName: preserve,
  lastAgentName: preserve,
  workspacePath: clearFor(recreateDetachNewAttempt),
  containerId: clearFor(['recreate', 'detach', 'retryTask', 'newAttempt']),
  experiments: preserve,
  selectedExperiment: preserve,
  selectedExperiments: preserve,
  experimentResults: preserve,
  pendingFixError: clearFor(['detach', 'retryTask', 'retryWorkflow', 'newAttempt']),
  isFixingWithAI: falseFor(['detach', 'retryTask', 'retryWorkflow', 'newAttempt']),
  reviewUrl: clearFor(['recreate', 'detach']),
  reviewId: clearFor(['recreate', 'detach']),
  reviewStatus: clearFor(['recreate', 'detach']),
  reviewProviderId: clearFor(['recreate', 'detach']),
  phase: clearFor(launchReset),
  launchStartedAt: clearFor(launchReset),
  launchCompletedAt: clearFor(launchReset),
  mergeConflict: preserve,
  selectedAttemptId: preserve,
  autoFixAttempts: zeroFor(['recreate', 'detach', 'retryTask', 'retryWorkflow']),
} satisfies TaskExecutionResetRulebook;

export function buildTaskResetExecutionPatch(
  kind: TaskResetKind,
  overrides?: Partial<TaskExecution>,
): Partial<TaskExecution> {
  const execution: Partial<TaskExecution> = {};
  const writableExecution = execution as Record<string, unknown>;
  for (const [field, rules] of Object.entries(TASK_EXECUTION_RESET_RULES) as Array<[
    keyof TaskExecution,
    Record<TaskResetKind, ResetRule>,
  ]>) {
    const rule = rules[kind];
    if (rule === 'clear') {
      writableExecution[field] = undefined;
    } else if (rule === 'false') {
      writableExecution[field] = false;
    } else if (rule === 'zero') {
      writableExecution[field] = 0;
    }
  }
  return overrides ? { ...execution, ...overrides } : execution;
}

export function buildTaskResetChanges(
  kind: TaskResetKind,
  options?: {
    config?: TaskStateChanges['config'];
    execution?: Partial<TaskExecution>;
  },
): TaskStateChanges {
  return {
    status: 'pending',
    ...(options?.config !== undefined ? { config: options.config } : {}),
    execution: buildTaskResetExecutionPatch(kind, options?.execution),
  };
}
