import { vi } from 'vitest';
import type { Workflow, WorkflowMutationIntent, WorkflowMutationPriority, WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import { createAutoFixAttemptLedger, type AutoFixAttemptLedger, type ReviewGateFailedCheck } from '@invoker/execution-engine';
import type { CommandService, Orchestrator, TaskState, TaskStatus } from '@invoker/workflow-core';
import { LocalBus, type MessageBus } from '@invoker/transport';

import type { HeadlessDeps } from '../headless.js';
import type { ReviewGateCiRepairCommandStore } from '../review-gate-ci-repair-command.js';

export const failedChecks: ReviewGateFailedCheck[] = [
  { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' },
  { name: 'lint', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/2' },
];

export function makeLogger() {
  const logger: any = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  };
  logger.child = vi.fn(() => logger);
  return logger;
}

export function makeReviewGateArtifact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pr-123',
    providerId: '123',
    provider: 'github',
    required: true,
    status: 'open',
    generation: 2,
    url: 'https://github.com/owner/repo/pull/123',
    headSha: 'sha-1',
    headRef: 'feature/ci',
    branch: 'feature/ci',
    checksState: 'failure',
    failedChecks,
    rawStatus: 'CI failed',
    ...overrides,
  };
}

export function makeReviewGateTask(overrides: {
  id?: string;
  status?: TaskStatus;
  config?: Record<string, unknown>;
  execution?: Record<string, unknown>;
} = {}): TaskState {
  return {
    id: overrides.id ?? 'wf-1/merge',
    description: 'Merge PR',
    status: overrides.status ?? 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: {
      workflowId: 'wf-1',
      isMergeNode: true,
      runnerKind: 'worktree',
      ...(overrides.config ?? {}),
    },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/ci',
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
      reviewStatus: 'CI failed',
      reviewGate: {
        activeGeneration: 2,
        artifacts: [makeReviewGateArtifact()],
      },
      ...(overrides.execution ?? {}),
    },
    taskStateVersion: 10,
  } as unknown as TaskState;
}

export function makeReviewGateRepairHarness(tasks: TaskState[] = [makeReviewGateTask()]) {
  const workflow = {
    id: 'wf-1',
    name: 'Workflow one',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Workflow;
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const actions = new Map<string, WorkerActionRecord>();
  const intents: WorkflowMutationIntent[] = [];
  const now = '2026-01-01T00:00:00.000Z';
  const store: ReviewGateCiRepairCommandStore = {
    listWorkflows: vi.fn(() => [workflow]),
    loadWorkflow: vi.fn((workflowId: string) => workflowId === workflow.id ? workflow : undefined),
    loadTasks: vi.fn((workflowId: string) => workflowId === workflow.id ? tasks : []),
    loadTask: vi.fn((taskId: string) => taskById.get(taskId)),
    listWorkflowMutationIntents: vi.fn(() => intents),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const saved = {
        ...write,
        createdAt: existing?.createdAt ?? now,
        updatedAt: write.updatedAt ?? now,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
      } as WorkerActionRecord;
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  const submit = vi.fn((
    _workflowId: string,
    _priority: WorkflowMutationPriority,
    _channel: 'invoker:fix-with-agent',
    _args: unknown[],
  ) => 42);

  return {
    workflow,
    tasks,
    task: tasks[0],
    actions,
    intents,
    store,
    submit,
    submitter: { submit },
    attemptLedger: createAutoFixAttemptLedger(),
    logger: makeLogger(),
  };
}

export function makeHeadlessDeps(harness: ReturnType<typeof makeReviewGateRepairHarness>, attemptLedger?: AutoFixAttemptLedger): HeadlessDeps {
  return {
    logger: harness.logger,
    orchestrator: {
      syncFromDb: vi.fn(),
      getAllTasks: vi.fn(() => []),
    } as unknown as Orchestrator,
    persistence: harness.store as any,
    commandService: {} as CommandService,
    executorRegistry: {} as any,
    messageBus: new LocalBus() as MessageBus,
    repoRoot: '/fake/repo',
    invokerConfig: { autoFixRetries: 2 } as any,
    initServices: vi.fn(async () => {}),
    wireSlackBot: vi.fn(async () => ({})),
    reviewGateCiRepairSubmitter: harness.submitter,
    reviewGateCiRepairAttemptLedger: attemptLedger ?? createAutoFixAttemptLedger(),
  };
}
