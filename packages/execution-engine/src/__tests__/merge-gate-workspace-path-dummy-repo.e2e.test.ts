import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Orchestrator, computeWorkflowRollup, type TaskState } from '@invoker/workflow-core';
import type { TaskStateChanges } from '@invoker/workflow-core';
import { ExecutorRegistry } from '../registry.js';
import { TaskRunner } from '../task-runner.js';
import { runMergeGateActionImpl } from '../merge-runner.js';
import type { MergeGateApprovalStatus, MergeGateProvider } from '../merge-gate-provider.js';

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

  getWorkspacePath(taskId: string): string | null {
    return this.tasks.get(taskId)?.task.execution.workspacePath ?? null;
  }

  logEvent(): void {}

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

const provider: MergeGateProvider = {
  name: 'dummy-review',
  async createReview() {
    return { url: 'https://example.invalid/dummy-repo/pull/1', identifier: '1' };
  },
  async closeReview() {},
  async checkApproval(): Promise<MergeGateApprovalStatus> {
    return {
      lifecycle: 'open',
      rejected: false,
      statusText: 'Awaiting review',
      url: 'https://example.invalid/dummy-repo/pull/1',
      checks: { state: 'success', failed: [] },
    };
  },
};

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return this; },
};

describe('merge-gate workspace path response route with a dummy repo', () => {
  const tempRoots: string[] = [];
  const originalInvokerDbDir = process.env.INVOKER_DB_DIR;

  afterEach(() => {
    if (originalInvokerDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = originalInvokerDbDir;
    }
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists the gate folder from the review_ready WorkResponse without legacy taskChanges', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'invoker-merge-gate-ws-e2e-'));
    tempRoots.push(tempRoot);
    process.env.INVOKER_DB_DIR = join(tempRoot, 'invoker-home');

    const dummy = makeDummyRepo(tempRoot);
    const persistence = new MemoryPersistence();
    const orchestrator = new Orchestrator({
      persistence: persistence as any,
      messageBus: { publish() {} },
      maxConcurrency: 2,
    });

    const featureBranch = `experiment/e2e-merge-gate-workspace-${Date.now()}`;
    orchestrator.loadPlan({
      name: 'Dummy repo merge-gate workspace proof',
      repoUrl: dummy.repoUrl,
      onFinish: 'none',
      mergeMode: 'external_review',
      baseBranch: 'main',
      featureBranch,
      tasks: [{
        id: 'change',
        description: 'Change dummy repo file',
        command: 'printf proof > proof.txt && git add proof.txt',
        dependencies: [],
      }],
    });
    orchestrator.startExecution();

    const task = orchestrator.getAllTasks().find((candidate) => !candidate.config.isMergeNode);
    expect(task).toBeDefined();
    if (!task) return;

    const taskBranch = `experiment/e2e-dummy-task-${Date.now()}`;
    git(dummy.seed, ['checkout', '-b', taskBranch, 'main']);
    writeFileSync(join(dummy.seed, 'proof.txt'), 'workspace path proof\n', 'utf8');
    git(dummy.seed, ['add', 'proof.txt']);
    git(dummy.seed, ['commit', '-m', 'Add workspace path proof change']);
    const taskCommit = git(dummy.seed, ['rev-parse', 'HEAD']);
    git(dummy.seed, ['push', 'origin', `${taskBranch}:refs/heads/${taskBranch}`]);

    orchestrator.handleWorkerResponse({
      requestId: 'complete-dummy-task',
      actionId: task.id,
      executionGeneration: task.execution.generation ?? 0,
      status: 'completed',
      outputs: {
        exitCode: 0,
        branch: taskBranch,
        commitHash: taskCommit,
      },
    });

    const mergeTask = orchestrator.getAllTasks().find((candidate) => candidate.config.isMergeNode);
    expect(mergeTask).toBeDefined();
    if (!mergeTask) return;
    expect(mergeTask.status).toBe('running');
    expect(persistence.getWorkspacePath(mergeTask.id)).toBeNull();

    const runner = new TaskRunner({
      orchestrator,
      persistence: persistence as any,
      executorRegistry: new ExecutorRegistry(),
      cwd: dummy.seed,
      defaultBranch: 'main',
      mergeGateProvider: provider,
      logger,
    });
    (runner as any).authorPrBodyWithSkill = async () => ({
      body: 'Dummy repo review body',
      sessionId: 'dummy-repo-proof',
      agentName: 'dummy-repo-proof',
    });

    const result = await runMergeGateActionImpl(runner as any, mergeTask);
    expect(result.response.status).toBe('review_ready');
    const responseWorkspacePath = result.response.outputs.workspacePath;
    expect(responseWorkspacePath).toBeTruthy();
    expect(existsSync(responseWorkspacePath!)).toBe(true);
    expect(resolve(responseWorkspacePath!)).not.toBe(resolve(dummy.seed));

    // This is the important precondition: the old side-save route was not used.
    // If the response route drops workspacePath, the assertion after
    // handleWorkerResponse fails.
    expect(persistence.getWorkspacePath(mergeTask.id)).toBeNull();

    orchestrator.handleWorkerResponse(result.response);

    expect(persistence.getWorkspacePath(mergeTask.id)).toBe(responseWorkspacePath);
    expect(git(responseWorkspacePath!, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
    expect(git(responseWorkspacePath!, ['branch', '--show-current'])).toBe(featureBranch);
  });
});
