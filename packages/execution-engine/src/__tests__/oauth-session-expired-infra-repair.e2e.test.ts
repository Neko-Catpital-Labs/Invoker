import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import { Orchestrator, computeWorkflowRollup, type TaskState } from '@invoker/workflow-core';
import type { TaskStateChanges } from '@invoker/workflow-core';
import { PR_6976_OAUTH_SESSION_EXPIRED_ERROR } from './fixtures/pr-6976-oauth-session-expired.js';
import {
  createInfraRepairTick,
  INFRA_REPAIR_WORKER_KIND,
} from '../workers/infra-repair-worker.js';

type WorkflowRecord = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  repoUrl?: string;
  onFinish?: 'none' | 'merge' | 'pull_request';
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: 'manual' | 'automatic' | 'external_review';
};

type TaskEventRecord = {
  eventType: string;
  payload?: string;
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Invoker E2E',
      GIT_AUTHOR_EMAIL: 'invoker-e2e@example.invalid',
      GIT_COMMITTER_NAME: 'Invoker E2E',
      GIT_COMMITTER_EMAIL: 'invoker-e2e@example.invalid',
    },
  }).trim();
}

class MemoryPersistence {
  workflows = new Map<string, WorkflowRecord>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  attempts = new Map<string, unknown[]>();
  events = new Map<string, TaskEventRecord[]>();

  saveWorkflow(workflow: WorkflowRecord): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, {
      ...workflow,
      status: 'pending',
      createdAt: workflow.createdAt ?? now,
      updatedAt: workflow.updatedAt ?? now,
    });
  }

  updateWorkflow(workflowId: string, changes: Partial<WorkflowRecord>): void {
    const workflow = this.workflows.get(workflowId);
    if (workflow) this.workflows.set(workflowId, { ...workflow, ...changes });
  }

  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    entry.task = {
      ...entry.task,
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
      config: { ...entry.task.config, ...(changes.config ?? {}) },
      execution: { ...entry.task.execution, ...(changes.execution ?? {}) },
      taskStateVersion: (entry.task.taskStateVersion ?? 1) + 1,
    } as TaskState;
  }

  loadTasks(workflowId: string): TaskState[] {
    return [...this.tasks.values()]
      .filter((entry) => entry.workflowId === workflowId)
      .map((entry) => entry.task);
  }

  private withRollup(workflow: WorkflowRecord): WorkflowRecord {
    const rollup = computeWorkflowRollup(this.loadTasks(workflow.id));
    return { ...workflow, status: rollup.status };
  }

  listWorkflows(): WorkflowRecord[] {
    return [...this.workflows.values()].map((workflow) => this.withRollup(workflow));
  }

  loadWorkflow(workflowId: string): WorkflowRecord | undefined {
    const workflow = this.workflows.get(workflowId);
    return workflow ? this.withRollup(workflow) : undefined;
  }

  logEvent(taskId: string, eventType: string, payload?: unknown): void {
    const list = this.events.get(taskId) ?? [];
    list.push({
      eventType,
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
    this.events.set(taskId, list);
  }

  getEvents(taskId: string): TaskEventRecord[] {
    return this.events.get(taskId) ?? [];
  }

  saveAttempt(attempt: { nodeId: string }): void {
    const list = this.attempts.get(attempt.nodeId) ?? [];
    list.push(attempt);
    this.attempts.set(attempt.nodeId, list);
  }

  loadAttempts(nodeId: string): unknown[] {
    return this.attempts.get(nodeId) ?? [];
  }

  loadAttempt(attemptId: string): unknown | undefined {
    for (const attempts of this.attempts.values()) {
      const found = attempts.find((attempt) => {
        return typeof attempt === 'object' && attempt !== null && 'id' in attempt && attempt.id === attemptId;
      });
      if (found) return found;
    }
    return undefined;
  }

  updateAttempt(attemptId: string, changes: Record<string, unknown>): void {
    for (const [nodeId, attempts] of this.attempts.entries()) {
      const index = attempts.findIndex((attempt) => {
        return typeof attempt === 'object' && attempt !== null && 'id' in attempt && attempt.id === attemptId;
      });
      if (index >= 0) {
        attempts[index] = { ...(attempts[index] as Record<string, unknown>), ...changes };
        this.attempts.set(nodeId, attempts);
        return;
      }
    }
  }
}

function makeDummyRepo(tempRoot: string): { seed: string; repoUrl: string } {
  const bare = join(tempRoot, 'dummy-origin.git');
  const seed = join(tempRoot, 'dummy-seed');
  mkdirSync(seed, { recursive: true });
  git(tempRoot, ['init', '--bare', bare]);
  git(seed, ['init']);
  git(seed, ['config', 'user.name', 'Invoker E2E']);
  git(seed, ['config', 'user.email', 'invoker-e2e@example.invalid']);
  writeFileSync(join(seed, 'README.md'), '# dummy repo\n', 'utf8');
  git(seed, ['add', 'README.md']);
  git(seed, ['commit', '-m', 'Initial dummy repo']);
  git(seed, ['branch', '-M', 'main']);
  git(seed, ['remote', 'add', 'origin', pathToFileURL(bare).href]);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { seed, repoUrl: pathToFileURL(bare).href };
}

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return this; },
};

describe('oauth-session-expired infra repair with a dummy repo', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records exactly one operator alert and no follow-up mutation for a persisted OAuth-expiry failure', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'invoker-oauth-expiry-e2e-'));
    tempRoots.push(tempRoot);

    const dummy = makeDummyRepo(tempRoot);
    const persistence = new MemoryPersistence();
    const orchestrator = new Orchestrator({
      persistence: persistence as any,
      messageBus: { publish() {} },
      maxConcurrency: 2,
      availablePoolIds: ['ssh-pool'],
    });

    orchestrator.loadPlan({
      name: 'Dummy repo OAuth-session-expired proof',
      repoUrl: dummy.repoUrl,
      onFinish: 'none',
      baseBranch: 'main',
      tasks: [{
        id: 'expired-task',
        description: 'SSH task that fails with an expired OAuth session',
        command: 'pnpm test',
        dependencies: [],
        poolId: 'ssh-pool',
      }],
    });
    orchestrator.startExecution();

    const task = orchestrator.getAllTasks().find((candidate) => !candidate.config.isMergeNode);
    expect(task).toBeDefined();
    if (!task) return;
    expect(task.config.runnerKind).toBe('ssh');

    persistence.logEvent(task.id, 'task.executor.selected', {
      runnerKind: 'ssh',
      poolMemberId: 'remote-1',
    });

    orchestrator.handleWorkerResponse({
      requestId: 'fail-expired-task',
      actionId: task.id,
      executionGeneration: task.execution.generation ?? 0,
      status: 'failed',
      outputs: {
        exitCode: 1,
        error: PR_6976_OAUTH_SESSION_EXPIRED_ERROR,
      },
    });

    const failed = orchestrator.getTask(task.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.execution.failureClass).toBe('ssh-oauth-session-expired');

    const actions = new Map<string, WorkerActionRecord>();
    const submit = vi.fn(() => 1);
    const tick = createInfraRepairTick({
      store: {
        listWorkflows: () => persistence.listWorkflows(),
        loadTasks: (workflowId: string) => persistence.loadTasks(workflowId),
        getEvents: (taskId: string) => persistence.getEvents(taskId) as never,
        getWorkerAction: (workerKind: string, externalKey: string) =>
          actions.get(`${workerKind}:${externalKey}`),
        upsertWorkerAction: (write: WorkerActionWrite) => {
          const key = `${write.workerKind}:${write.externalKey}`;
          const existing = actions.get(key);
          const now = new Date().toISOString();
          const saved: WorkerActionRecord = {
            ...write,
            id: existing?.id ?? write.id ?? key,
            attemptCount: write.attemptCount ?? 0,
            createdAt: existing?.createdAt ?? now,
            updatedAt: write.updatedAt ?? now,
          };
          actions.set(key, saved);
          return saved;
        },
      },
      submitter: { submit },
      logger,
      ownerRepoRoot: dummy.seed,
      ownerInvokerHome: join(tempRoot, '.invoker'),
      remoteTargets: {
        'remote-1': {
          host: '203.0.113.10',
          user: 'invoker',
          sshKeyPath: join(tempRoot, 'key'),
        },
      },
    });

    await tick({
      identity: { kind: INFRA_REPAIR_WORKER_KIND, instanceId: 'e2e' },
      reason: 'poll',
      tickNumber: 1,
      signal: new AbortController().signal,
    });

    expect(submit).not.toHaveBeenCalled();

    const recorded = [...actions.values()];
    const targetActions = recorded.filter((action) => action.actionType === 'repair-target');
    expect(targetActions).toHaveLength(1);
    expect(targetActions[0]).toEqual(expect.objectContaining({
      workerKind: INFRA_REPAIR_WORKER_KIND,
      subjectType: 'infra-target',
      subjectId: 'remote-1',
      status: 'failed',
      payload: expect.objectContaining({ infraReason: 'ssh-oauth-session-expired' }),
    }));

    const taskDecisions = recorded.filter((action) => action.actionType === 'repair-infra-failure');
    expect(taskDecisions).toHaveLength(1);
    expect(taskDecisions[0]).toEqual(expect.objectContaining({
      taskId: task.id,
      status: 'completed',
      payload: expect.objectContaining({ infraReason: 'ssh-oauth-session-expired' }),
    }));
  });
});
