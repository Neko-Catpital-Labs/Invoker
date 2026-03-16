import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { FamiliarHandle, PersistedTaskMeta, TerminalSpec } from './familiar.js';
import { BaseFamiliar, type BaseEntry, MergeConflictError } from './base-familiar.js';
import { killProcessGroup, cleanElectronEnv, SIGKILL_TIMEOUT_MS } from './process-utils.js';

interface ProcessEntry extends BaseEntry {
  process: ChildProcess | null;
  /** Set to true when a fallback spawn replaces the original child. */
  fallbackActive: boolean;
  /** Claude session ID for resuming sessions on terminal double-click. */
  claudeSessionId?: string;
  /** Branch that was checked out before setupTaskBranch created the task branch. */
  originalBranch?: string;
  /** Task branch created by setupTaskBranch, for post-sync push. */
  taskBranch?: string;
}

export interface LocalFamiliarOptions {
  /** Command to invoke the Claude CLI. Defaults to 'claude'. */
  claudeCommand?: string;
  /** When true, fall back to echo stub if the Claude CLI is not found. Defaults to true. */
  claudeFallback?: boolean;
  /** Heartbeat interval in ms for orphan detection. Defaults to 30000. */
  heartbeatIntervalMs?: number;
}

export class LocalFamiliar extends BaseFamiliar<ProcessEntry> {
  readonly type = 'local';
  private claudeCommand: string;
  private claudeFallback: boolean;
  private workspaceLocks = new Map<string, Promise<void>>();

  constructor(options: LocalFamiliarOptions = {}) {
    super(options.heartbeatIntervalMs);
    this.claudeCommand = options.claudeCommand ?? 'claude';
    this.claudeFallback = options.claudeFallback ?? true;
  }

  async start(request: WorkRequest): Promise<FamiliarHandle> {
    const handle = this.createHandle(request);
    const executionId = handle.executionId;

    // ── Reconciliation: no process, immediate needs_input ──
    if (request.actionType === 'reconciliation') {
      const entry: ProcessEntry = {
        process: null,
        request,
        outputListeners: new Set(),
        outputBuffer: [],
        completeListeners: new Set(),
        heartbeatListeners: new Set(),
        completed: false,
        fallbackActive: false,
      };
      this.registerEntry(handle, entry);
      this.scheduleReconciliationResponse(handle.executionId);
      return handle;
    }

    // ── Determine command and args ──
    const { cmd, args, claudeSessionId, fullPrompt } = this.buildCommandAndArgs(request, this.claudeCommand);
    if (claudeSessionId && fullPrompt) {
      console.log(`[LocalFamiliar] Starting Claude session ${claudeSessionId} with prompt:\n${fullPrompt}`);
    }

    const cwd = request.inputs.workspacePath ?? process.cwd();
    console.log(`[LocalFamiliar] ${request.actionId} workspace: ${cwd}`);

    // Serialize checkout+spawn per workspace to prevent branch races
    const prevLock = this.workspaceLocks.get(cwd) ?? Promise.resolve();
    let releaseLock!: () => void;
    const newLock = new Promise<void>(r => { releaseLock = r; });
    this.workspaceLocks.set(cwd, newLock);
    await prevLock;

    let originalBranch: string | undefined;
    let child: ChildProcess;
    try {
      // Create feature branch before spawning if specified
      if (request.inputs.featureBranch && request.inputs.workspacePath) {
        await this.ensureFeatureBranch(
          request.inputs.workspacePath,
          request.inputs.featureBranch,
        );
      }

      // Pre-sync: pull latest from remote
      await this.syncFromRemote(cwd, handle.executionId);

      // Create task-specific branch based off upstream dependency branch
      originalBranch = await this.setupTaskBranch(cwd, request, handle);

      child = spawn(cmd, args, {
        stdio: [request.actionType === 'claude' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        cwd,
        detached: true,
        env: cleanElectronEnv(),
      });
    } catch (err) {
      if (err instanceof MergeConflictError) {
        const entry: ProcessEntry = {
          process: null, request,
          outputListeners: new Set(), outputBuffer: [],
          completeListeners: new Set(), heartbeatListeners: new Set(),
          completed: true, fallbackActive: false,
        };
        this.registerEntry(handle, entry);
        const response: WorkResponse = {
          requestId: request.requestId,
          actionId: request.actionId,
          status: 'failed',
          outputs: {
            exitCode: 1,
            error: JSON.stringify({
              type: 'merge_conflict',
              failedBranch: err.failedBranch,
              conflictFiles: err.conflictFiles,
            }),
          },
        };
        this.emitComplete(handle.executionId, response);
        return handle;
      }
      throw err;
    } finally {
      releaseLock();
    }

    const entry: ProcessEntry = {
      process: child,
      request,
      outputListeners: new Set(),
      outputBuffer: [],
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
      completed: false,
      fallbackActive: false,
      claudeSessionId,
      originalBranch,
      taskBranch: handle.branch,
    };

    this.registerEntry(handle, entry);

    // Expose session ID on handle for persistence by caller
    if (claudeSessionId) {
      handle.claudeSessionId = claudeSessionId;
    }

    // ── Claude fallback: if spawn fails with ENOENT, retry as echo stub ──
    if (request.actionType === 'claude' && this.claudeFallback) {
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          entry.fallbackActive = true;
          const prompt = request.inputs.prompt ?? '';
          const fallbackChild = spawn('/bin/sh', ['-c', `echo "Claude prompt: ${prompt}"`], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: request.inputs.workspacePath,
            detached: true,
            env: cleanElectronEnv(),
          });
          // Replace the process reference
          entry.process = fallbackChild;
          this.wireChildEvents(executionId, fallbackChild, entry);
        }
      });
    }

    this.wireChildEvents(executionId, child, entry);
    this.startHeartbeat(executionId, child);

    // Generic error handler: catch spawn errors that are NOT handled by
    // the ENOENT fallback above (e.g., EACCES, EPERM, or other failures).
    child.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT on claude tasks with fallback enabled is handled above
      if (err.code === 'ENOENT' && request.actionType === 'claude' && this.claudeFallback) {
        return;
      }
      if (!entry.completed && !entry.fallbackActive) {
        entry.completed = true;
        const response: WorkResponse = {
          requestId: request.requestId,
          actionId: request.actionId,
          status: 'failed',
          outputs: {
            exitCode: 1,
            error: `Spawn error: ${err.message}`,
          },
        };
        for (const cb of entry.completeListeners) {
          cb(response);
        }
      }
    });

    return handle;
  }

  /** Wire stdout, stderr, and close events from a child process to a ProcessEntry. */
  private wireChildEvents(executionId: string, child: ChildProcess, entry: ProcessEntry): void {
    child.stdout?.on('data', (chunk: Buffer) => {
      this.emitOutput(executionId, chunk.toString());
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.emitOutput(executionId, chunk.toString());
    });

    child.on('close', async (code, signal) => {
      if (entry.process !== child) return;
      const taskCwd = entry.request.inputs.workspacePath ?? process.cwd();
      const exitCode = code ?? (signal ? 1 : 0);
      await this.handleProcessExit(executionId, entry.request, taskCwd, exitCode, {
        signal,
        branch: entry.taskBranch,
        originalBranch: entry.originalBranch,
        claudeSessionId: entry.claudeSessionId,
      });
    });
  }

  async kill(handle: FamiliarHandle): Promise<void> {
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.completed) return;

    // No-process entries (e.g. reconciliation) are already completed or have nothing to kill
    if (!entry.process) return;

    return new Promise<void>((resolve) => {
      const child = entry.process!;

      const killTimer = setTimeout(() => {
        if (!entry.completed) {
          killProcessGroup(child, 'SIGKILL');
        }
      }, SIGKILL_TIMEOUT_MS);

      child.on('close', () => {
        clearTimeout(killTimer);
        resolve();
      });

      // If already exited, resolve immediately
      if (entry.completed) {
        clearTimeout(killTimer);
        resolve();
        return;
      }

      killProcessGroup(child, 'SIGTERM');
    });
  }

  sendInput(handle: FamiliarHandle, input: string): void {
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.completed) return;
    entry.process?.stdin?.write(input);
  }

  getTerminalSpec(handle: FamiliarHandle): TerminalSpec | null {
    const entry = this.entries.get(handle.executionId);
    if (!entry) return null;
    if (entry.claudeSessionId) {
      return { command: 'claude', args: ['--resume', entry.claudeSessionId] };
    }
    return { cwd: entry.request.inputs.workspacePath ?? process.cwd() };
  }

  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec {
    console.log(`[LocalFamiliar] getRestoredTerminalSpec task="${meta.taskId}" workspacePath="${meta.workspacePath ?? 'none'}" sessionId="${meta.claudeSessionId ?? 'none'}"`);
    if (meta.workspacePath && !existsSync(meta.workspacePath)) {
      console.log(`[LocalFamiliar] getRestoredTerminalSpec task="${meta.taskId}" — workspace path does NOT exist`);
      throw new Error(`Workspace path ${meta.workspacePath} no longer exists for task ${meta.taskId}`);
    }
    if (meta.workspacePath) {
      console.log(`[LocalFamiliar] getRestoredTerminalSpec task="${meta.taskId}" — workspace path exists`);
    }
    if (meta.claudeSessionId) {
      const spec = {
        command: 'claude',
        args: ['--resume', meta.claudeSessionId, '--dangerously-skip-permissions'],
        cwd: meta.workspacePath,
      };
      console.log(`[LocalFamiliar] getRestoredTerminalSpec task="${meta.taskId}" → claude --resume spec, cwd="${spec.cwd}"`);
      return spec;
    }
    console.log(`[LocalFamiliar] getRestoredTerminalSpec task="${meta.taskId}" → cwd-only spec, cwd="${meta.workspacePath}"`);
    return { cwd: meta.workspacePath };
  }

  async destroyAll(): Promise<void> {
    const entries = Array.from(this.entries.entries());
    const closePromises: Promise<void>[] = [];

    for (const [_executionId, entry] of entries) {
      if (!entry.completed && entry.process) {
        closePromises.push(
          new Promise<void>((resolve) => {
            entry.process!.on('close', () => resolve());

            killProcessGroup(entry.process!, 'SIGTERM');

            // Escalate to SIGKILL after timeout
            setTimeout(() => {
              if (!entry.completed && entry.process) {
                killProcessGroup(entry.process, 'SIGKILL');
              }
            }, SIGKILL_TIMEOUT_MS);
          }),
        );
      }
    }

    await Promise.all(closePromises);
    this.entries.clear();
  }
}
