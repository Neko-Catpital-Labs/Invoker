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
  title?: string;
  body?: string;
  mergeable?: string;
  mergeStateStatus?: string;
}

export interface WorkerGitHubComment {
  body: string;
  updatedAt: string;
  path?: string;
  url?: string;
  authorLogin?: string;
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
  listPullRequests?(args: {
    owner: string;
    repo: string;
    author?: string;
    state?: 'open' | 'closed' | 'all';
    limit?: number;
  }): Promise<WorkerGitHubPullRequest[]>;
  getPullRequest(args: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<WorkerGitHubPullRequest | undefined>;
  listPullRequestReviewComments?(args: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<WorkerGitHubComment[]>;
  listIssueComments?(args: {
    owner: string;
    repo: string;
    issueNumber: number;
  }): Promise<WorkerGitHubComment[]>;
  createPullRequestComment?(args: {
    owner: string;
    repo: string;
    pullNumber: number;
    body: string;
  }): Promise<void>;
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

export interface PrMaintenanceCommandResult {
  stdout: string;
  stderr: string;
}

export interface PrMaintenanceCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type PrMaintenanceCommandRunner = (
  command: string,
  args: string[],
  options?: PrMaintenanceCommandOptions,
) => Promise<PrMaintenanceCommandResult>;

export interface CoderabbitUpdateWorkerConfig {
  targetRepo?: string;
  author?: string;
  login?: string;
  maxAttempts?: number;
  workDir?: string;
  executionAgent?: string;
  executionModel?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface MergeConflictRebaseWorkerConfig {
  targetRepo?: string;
  author?: string;
  maxAttempts?: number;
  pollIntervalMs?: number;
  confirmTimeoutMs?: number;
  confirmPollIntervalMs?: number;
}

export interface PrMaintenanceAutomationConfig {
  targetRepo?: string;
  author?: string;
  coderabbit?: CoderabbitUpdateWorkerConfig;
  mergeConflictRebase?: MergeConflictRebaseWorkerConfig;
}
