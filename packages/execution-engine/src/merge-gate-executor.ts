import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import { BaseExecutor, type BaseEntry } from './base-executor.js';
import type { ExecutorHandle, PersistedTaskMeta, TerminalSpec } from './executor.js';
import type { MergeRunnerHost, MergeGateLineage } from './merge-runner.js';
import { runMergeGateActionImpl, updateMergeGateMetadataIfCurrent } from './merge-runner.js';

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
    const launchWorkspacePath = this.createLaunchWorkspace(task.id);

    const handle = this.createHandle(request);
    handle.workspacePath = launchWorkspacePath;
    handle.branch = workflow?.featureBranch ?? undefined;

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
      void this.run(handle, task, launchWorkspacePath);
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
      entry.heartbeatTimer = undefined;
      if (!entry.completed) {
        entry.killed = true;
        this.emitComplete(executionId, {
          requestId: entry.request.requestId,
          actionId: entry.request.actionId,
          attemptId: entry.request.attemptId,
          executionGeneration: entry.request.executionGeneration,
          status: 'failed',
          outputs: {
            exitCode: 1,
            error: 'Merge gate execution was stopped before completion',
          },
        });
      }
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

  private createLaunchWorkspace(taskId: string): string {
    const invokerHomeRoot = process.env.INVOKER_DB_DIR
      ? resolve(process.env.INVOKER_DB_DIR)
      : resolve(homedir(), '.invoker');
    const launchRoot = resolve(invokerHomeRoot, 'merge-launches');
    mkdirSync(launchRoot, { recursive: true });
    return mkdtempSync(resolve(launchRoot, `launch-${taskId.replace(/[^a-zA-Z0-9_-]/g, '-')}-`));
  }

  private cleanupLaunchWorkspace(launchWorkspacePath: string, realWorkspacePath: string | undefined): void {
    if (!realWorkspacePath || realWorkspacePath === launchWorkspacePath) return;
    try {
      rmSync(launchWorkspacePath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup. The real gate clone has already replaced this path.
    }
  }

  private async run(handle: ExecutorHandle, task: TaskState, launchWorkspacePath: string): Promise<void> {
    const entry = this.getEntry(handle);
    if (!entry || entry.completed || entry.killed) return;

    try {
      this.emitOutput(handle.executionId, `[merge] Starting merge gate action: ${task.id}\n`);
      // Launch lineage from the dispatched request. If the merge task is
      // relaunched while this long-running action is in flight, the direct
      // metadata write below must be suppressed so stale work cannot overwrite
      // the newer launch's branch/workspacePath/review fields.
      const lineage: MergeGateLineage = {
        selectedAttemptId: entry.request.attemptId,
        generation: entry.request.executionGeneration ?? 0,
      };
      const result = await runMergeGateActionImpl(this.host, task, { lineage });
      const executionChanges = result.taskChanges.execution
        ? {
          ...result.taskChanges.execution,
          workspacePath: result.taskChanges.execution.workspacePath ?? launchWorkspacePath,
        }
        : undefined;

      // The merge action may have taken minutes; destroyAll() can have killed or
      // deleted this entry meanwhile and already emitted a terminal failure. Do
      // not persist late execution state or complete again over that.
      const liveEntry = this.getEntry(handle);
      if (!liveEntry || liveEntry.completed || liveEntry.killed || entry.killed) {
        this.cleanupLaunchWorkspace(launchWorkspacePath, executionChanges?.workspacePath);
        return;
      }

      if (executionChanges?.workspacePath) {
        handle.workspacePath = executionChanges.workspacePath;
      }
      if (executionChanges?.branch) {
        handle.branch = executionChanges.branch;
      }
      if (executionChanges) {
        const applied = updateMergeGateMetadataIfCurrent(
          this.host,
          task.id,
          { execution: executionChanges },
          lineage,
        );
        if (!applied) {
          this.emitOutput(
            handle.executionId,
            `[merge] Skipped stale merge-gate metadata write for ${task.id} (merge task advanced to a newer launch)\n`,
          );
        }
      }
      this.cleanupLaunchWorkspace(launchWorkspacePath, executionChanges?.workspacePath);
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
