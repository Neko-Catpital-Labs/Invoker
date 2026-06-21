import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import { BaseExecutor, type BaseEntry } from './base-executor.js';
import type { ExecutorHandle, PersistedTaskMeta, TerminalSpec } from './executor.js';
import type { MergeRunnerHost } from './merge-runner.js';
import { runMergeGateActionImpl } from './merge-runner.js';
import { normalizeBranchForGithubCli } from './github-branch-ref.js';

interface MergeGateEntry extends BaseEntry {
  killed?: boolean;
}

export class MergeGateExecutor extends BaseExecutor<MergeGateEntry> {
  readonly type = 'merge';

  constructor(private readonly host: MergeRunnerHost) {
    super();
  }

  async start(request: WorkRequest): Promise<ExecutorHandle> {
    const task = this.resolveTask(request);
    const workflow = task.config.workflowId
      ? this.host.persistence.loadWorkflow(task.config.workflowId)
      : undefined;
    const onFinish = workflow?.onFinish ?? 'none';
    const mergeMode = workflow?.mergeMode ?? 'manual';
    let workspacePath: string | undefined;
    if (workflow?.featureBranch && (onFinish !== 'none' || mergeMode === 'external_review')) {
      const baseBranch = workflow.baseBranch ?? this.host.defaultBranch ?? await this.host.detectDefaultBranch();
      const baseCheckoutRef = normalizeBranchForGithubCli(baseBranch);
      workspacePath = await this.host.createMergeWorktree(
        baseCheckoutRef,
        'gate-' + task.id.replace(/[^a-zA-Z0-9_-]/g, '-'),
        workflow.repoUrl,
      );
    } else {
      workspacePath = createNoopGateWorkspace(task.id);
    }

    const handle = this.createHandle(request);
    handle.workspacePath = workspacePath;
    handle.branch = workflow?.featureBranch && (onFinish !== 'none' || mergeMode === 'external_review')
      ? workflow.featureBranch
      : undefined;

    const entry: MergeGateEntry = {
      request,
      outputListeners: new Set(),
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
      completed: false,
      outputBuffer: [],
      outputBufferBytes: 0,
      evictedChunkCount: 0,
    };
    this.registerEntry(handle, entry);
    entry.heartbeatTimer = setInterval(() => {
      if (entry.completed) {
        if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
        entry.heartbeatTimer = undefined;
        return;
      }
      this.emitHeartbeat(handle.executionId);
    }, this.heartbeatIntervalMs);

    setImmediate(() => {
      void this.run(handle, task, workspacePath);
    });

    return handle;
  }

  async kill(handle: ExecutorHandle): Promise<void> {
    const entry = this.getEntry(handle);
    if (!entry || entry.completed) return;
    entry.killed = true;
    this.emitComplete(handle.executionId, {
      requestId: entry.request.requestId,
      actionId: entry.request.actionId,
      attemptId: entry.request.attemptId,
      executionGeneration: entry.request.executionGeneration,
      status: 'failed',
      outputs: {
        exitCode: 1,
        error: 'Merge gate execution was cancelled',
      },
    });
  }

  sendInput(_handle: ExecutorHandle, _input: string): void {
    // Merge gates do not consume interactive input through the executor.
  }

  getTerminalSpec(handle: ExecutorHandle): TerminalSpec | null {
    return handle.workspacePath ? { cwd: handle.workspacePath } : null;
  }

  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec {
    if (!meta.workspacePath || !existsSync(meta.workspacePath)) {
      throw new Error(`Workspace path no longer exists for task ${meta.taskId}: ${meta.workspacePath ?? 'none'}`);
    }
    if (meta.branch) {
      const sh = process.platform === 'darwin' ? 'zsh' : 'bash';
      return {
        command: sh,
        args: ['-c', `git checkout '${meta.branch}' 2>/dev/null; exec ${sh}`],
        cwd: meta.workspacePath,
      };
    }
    return { cwd: meta.workspacePath };
  }

  async destroyAll(): Promise<void> {
    for (const [executionId, entry] of this.entries) {
      if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
      this.entries.delete(executionId);
    }
  }

  private resolveTask(request: WorkRequest): TaskState {
    const task = this.host.orchestrator.getTask(request.actionId);
    if (!task) {
      throw new Error(`Merge gate task ${request.actionId} not found`);
    }
    return task;
  }

  private async run(handle: ExecutorHandle, task: TaskState, gateWorkspacePath: string | undefined): Promise<void> {
    const entry = this.getEntry(handle);
    if (!entry || entry.completed || entry.killed) return;

    try {
      this.emitOutput(handle.executionId, `[merge] Starting merge gate action: ${task.id}\n`);
      const result = await runMergeGateActionImpl(this.host, task, { gateWorkspacePath });
      if (result.taskChanges.execution) {
        this.host.persistence.updateTask(task.id, {
          execution: result.taskChanges.execution,
        });
      }
      this.emitOutput(handle.executionId, `[merge] Merge gate action finished: ${task.id} status=${result.response.status}\n`);
      this.emitComplete(handle.executionId, this.withAttempt(entry.request, result.response));
    } catch (err) {
      const response: WorkResponse = {
        requestId: entry.request.requestId,
        actionId: task.id,
        attemptId: entry.request.attemptId,
        executionGeneration: entry.request.executionGeneration,
        status: 'failed',
        outputs: {
          exitCode: 1,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        },
      };
      this.emitComplete(handle.executionId, response);
    }
  }

  private withAttempt(request: WorkRequest, response: WorkResponse): WorkResponse {
    return {
      ...response,
      requestId: request.requestId,
      attemptId: response.attemptId ?? request.attemptId,
      executionGeneration: request.executionGeneration,
    };
  }
}

function createNoopGateWorkspace(taskId: string): string {
  const slug = taskId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const dbDir = process.env.INVOKER_DB_DIR?.trim();
  if (dbDir) {
    const dir = join(dbDir, 'merge-gates', slug);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  return mkdtempSync(join(tmpdir(), `invoker-merge-gate-${slug}-`));
}
