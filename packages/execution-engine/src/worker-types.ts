import type {
  ReviewGateLookup,
  WorkerActionListFilters,
  WorkerActionRecord,
  WorkerActionWrite,
  Workflow,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

export interface WorkerStateStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadWorkflow?(workflowId: string): Workflow | undefined;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  findReviewGateByPr?(pr: string): ReviewGateLookup | undefined;
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
  title?: string;
  headSha?: string;
  branch?: string;
  baseBranch?: string;
  mergeable?: string;
  mergeStateStatus?: string;
}

export interface WorkerGitHubComment {
  authorLogin: string;
  body: string;
  updatedAt: string;
  path?: string;
  htmlUrl?: string;
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
  listOpenPullRequests?(args: {
    owner: string;
    repo: string;
    author: string;
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

export interface PrMaintenanceWorkerConfig {
  targetRepo?: string;
  author?: string;
  coderabbitLogin?: string;
  coderabbitMaxAttempts?: number;
  coderabbitWorkDir?: string;
  coderabbitExecutionAgent?: string;
  coderabbitExecutionModel?: string;
  coderabbitTimeoutMs?: number;
  coderabbitPollIntervalMs?: number;
  mergeConflictMaxAttempts?: number;
  mergeConflictConfirmTimeoutMs?: number;
  mergeConflictConfirmPollMs?: number;
  mergeConflictPollIntervalMs?: number;
}

export interface WorkerConfig {
  kind: string;
  enabled?: boolean;
  pollIntervalMs?: number;
  maxAttempts?: number;
  agentName?: string;
  executionModel?: string;
}
