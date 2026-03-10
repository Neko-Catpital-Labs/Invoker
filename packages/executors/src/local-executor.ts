import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { Executor, ExecutorHandle, Unsubscribe } from './executor.js';

const SIGKILL_TIMEOUT_MS = 5_000;

interface ProcessEntry {
  process: ChildProcess | null;
  request: WorkRequest;
  outputListeners: Set<(data: string) => void>;
  completeListeners: Set<(response: WorkResponse) => void>;
  completed: boolean;
  outputBuffer: string[];
  /** Set to true when a fallback spawn replaces the original child. */
  fallbackActive: boolean;
}

export interface LocalExecutorOptions {
  /** Command to invoke the Claude CLI. Defaults to 'claude'. */
  claudeCommand?: string;
  /** When true, fall back to echo stub if the Claude CLI is not found. Defaults to true. */
  claudeFallback?: boolean;
}

/**
 * Sends a signal to the entire process group.
 * Uses negative PID to target the group when the process was spawned with detached: true.
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid == null) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    // Process group may already be dead
    return child.kill(signal);
  }
}

export class LocalExecutor implements Executor {
  readonly type = 'local';
  private processes = new Map<string, ProcessEntry>();
  private claudeCommand: string;
  private claudeFallback: boolean;

  constructor(options: LocalExecutorOptions = {}) {
    this.claudeCommand = options.claudeCommand ?? 'claude';
    this.claudeFallback = options.claudeFallback ?? true;
  }

  async start(request: WorkRequest): Promise<ExecutorHandle> {
    const executionId = randomUUID();
    const handle: ExecutorHandle = {
      executionId,
      taskId: request.actionId,
    };

    // ── Reconciliation: no process, immediate needs_input ──
    if (request.actionType === 'reconciliation') {
      const entry: ProcessEntry = {
        process: null,
        request,
        outputListeners: new Set(),
      outputBuffer: [],
        completeListeners: new Set(),
        completed: false,
        fallbackActive: false,
      };
      this.processes.set(executionId, entry);

      // Emit after caller has a chance to register onComplete listener
      setTimeout(() => {
        entry.completed = true;
        const response: WorkResponse = {
          requestId: request.requestId,
          actionId: request.actionId,
          status: 'needs_input',
          outputs: { summary: 'Select winning experiment' },
        };
        for (const cb of entry.completeListeners) {
          cb(response);
        }
      }, 0);

      return handle;
    }

    // ── Determine command and args ──
    let cmd: string;
    let args: string[];

    if (request.actionType === 'command') {
      const command = request.inputs.command;
      if (!command) {
        throw new Error('WorkRequest with actionType "command" must have inputs.command');
      }
      cmd = '/bin/sh';
      args = ['-c', command];
    } else if (request.actionType === 'claude') {
      const prompt = request.inputs.prompt ?? '';
      cmd = this.claudeCommand;
      args = ['-p', prompt, '--output-format', 'json'];
    } else {
      cmd = '/bin/sh';
      args = ['-c', 'echo "Unsupported action type"'];
    }

    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: request.inputs.workspacePath,
      detached: true,
    });

    const entry: ProcessEntry = {
      process: child,
      request,
      outputListeners: new Set(),
      outputBuffer: [],
      completeListeners: new Set(),
      completed: false,
      fallbackActive: false,
    };

    this.processes.set(executionId, entry);

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
          });
          // Replace the process reference
          entry.process = fallbackChild;
          this.wireChildEvents(fallbackChild, entry);
        }
      });
    }

    this.wireChildEvents(child, entry);

    return handle;
  }

  /** Wire stdout, stderr, and close events from a child process to a ProcessEntry. */
  private wireChildEvents(child: ChildProcess, entry: ProcessEntry): void {
    child.stdout?.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      for (const cb of entry.outputListeners) {
        cb(data);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      for (const cb of entry.outputListeners) {
        cb(data);
      }
    });

    child.on('close', (code, signal) => {
      // If a fallback process replaced this one, ignore the original close event
      if (entry.process !== child) return;

      entry.completed = true;
      const exitCode = code ?? (signal ? 1 : 0);
      const response: WorkResponse = {
        requestId: entry.request.requestId,
        actionId: entry.request.actionId,
        status: exitCode === 0 ? 'completed' : 'failed',
        outputs: {
          exitCode,
        },
      };
      for (const cb of entry.completeListeners) {
        cb(response);
      }
    });
  }

  async kill(handle: ExecutorHandle): Promise<void> {
    const entry = this.processes.get(handle.executionId);
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

  sendInput(handle: ExecutorHandle, input: string): void {
    const entry = this.processes.get(handle.executionId);
    if (!entry || entry.completed) return;
    entry.process?.stdin?.write(input);
  }

  onOutput(handle: ExecutorHandle, cb: (data: string) => void): Unsubscribe {
    const entry = this.processes.get(handle.executionId);
    if (!entry) {
      return () => {};
    }
    entry.outputListeners.add(cb);
    return () => {
      entry.outputListeners.delete(cb);
    };
  }

  onComplete(handle: ExecutorHandle, cb: (response: WorkResponse) => void): Unsubscribe {
    const entry = this.processes.get(handle.executionId);
    if (!entry) {
      return () => {};
    }
    entry.completeListeners.add(cb);
    return () => {
      entry.completeListeners.delete(cb);
    };
  }

  async destroyAll(): Promise<void> {
    const entries = Array.from(this.processes.entries());
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
    this.processes.clear();
  }
}
