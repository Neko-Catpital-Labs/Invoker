import type {
  WorkerActionListFilters,
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

export interface WorkerStateStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  getWorkerAction(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction(action: WorkerActionWrite): WorkerActionRecord;
  listWorkerActions(filters?: WorkerActionListFilters): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface WorkerMutationSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface WorkerGitHubPullRequest {
  owner: string;
  repo: string;
  number: number;
  url: string;
  state: string;
  headSha?: string;
  branch?: string;
  baseBranch?: string;
}

export interface WorkerGitHubCheckRun {
  name: string;
  status: string;
  conclusion?: string;
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkerGitHubClient {
  getPullRequest(args: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<WorkerGitHubPullRequest | undefined>;
  listCheckRuns?(args: {
    owner: string;
    repo: string;
    ref: string;
  }): Promise<WorkerGitHubCheckRun[]>;
}

export interface WorkerConfig {
  kind: string;
  enabled?: boolean;
  pollIntervalMs?: number;
  maxAttempts?: number;
  agentName?: string;
  executionModel?: string;
}
