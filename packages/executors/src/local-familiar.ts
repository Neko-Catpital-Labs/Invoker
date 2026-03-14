import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { FamiliarHandle, PersistedTaskMeta, TerminalSpec } from './familiar.js';
import { BaseFamiliar, type BaseEntry } from './base-familiar.js';

const SIGKILL_TIMEOUT_MS = 5_000;

interface ProcessEntry extends BaseEntry {
  process: ChildProcess | null;
  /** Set to true when a fallback spawn replaces the original child. */
  fallbackActive: boolean;
  /** Claude session ID for resuming sessions on terminal double-click. */
  claudeSessionId?: string;
}

export interface LocalFamiliarOptions {
  /** Command to invoke the Claude CLI. Defaults to 'claude'. */
  claudeCommand?: string;
  /** When true, fall back to echo stub if the Claude CLI is not found. Defaults to true. */
  claudeFallback?: boolean;
  /** Heartbeat interval in ms for orphan detection. Defaults to 30000. */
  heartbeatIntervalMs?: number;
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

export class LocalFamiliar extends BaseFamiliar<ProcessEntry> {
  readonly type = 'local';
  private claudeCommand: string;
  private claudeFallback: boolean;

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
    let claudeSessionId: string | undefined;

    if (request.actionType === 'command') {
      const command = request.inputs.command;
      if (!command) {
        throw new Error('WorkRequest with actionType "command" must have inputs.command');
      }
      cmd = '/bin/sh';
      args = ['-c', command];
    } else if (request.actionType === 'claude') {
      const session = this.prepareClaudeSession(request);
      cmd = this.claudeCommand;
      claudeSessionId = session.sessionId;
      console.log(`[LocalFamiliar] Starting Claude session ${claudeSessionId} with prompt:\n${session.fullPrompt}`);
      args = session.cliArgs;
    } else {
      cmd = '/bin/sh';
      args = ['-c', 'echo "Unsupported action type"'];
    }

    const cwd = request.inputs.workspacePath ?? process.cwd();
    console.log(`[LocalFamiliar] ${request.actionId} workspace: ${cwd}`);

    // Create feature branch before spawning if specified
    if (request.inputs.featureBranch && request.inputs.workspacePath) {
      await this.ensureFeatureBranch(
        request.inputs.workspacePath,
        request.inputs.featureBranch,
      );
    }

    // Strip Electron-specific env vars so child processes use system Node.js
    const cleanEnv = { ...process.env };
    delete cleanEnv.ELECTRON_RUN_AS_NODE;
    delete cleanEnv.ELECTRON_NO_ASAR;

    const child = spawn(cmd, args, {
      stdio: [request.actionType === 'claude' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      cwd,
      detached: true,
      env: cleanEnv,
    });

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
            env: cleanEnv,
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
      // If a fallback process replaced this one, ignore the original close event
      if (entry.process !== child) return;

      entry.completed = true;
      const exitCode = code ?? (signal ? 1 : 0);
      const signalInfo = signal ? ` signal=${signal}` : '';
      this.emitOutput(executionId,
        `[LocalFamiliar] Process exited: actionId=${entry.request.actionId} exitCode=${exitCode}${signalInfo}\n`);

      let commitHash: string | undefined;
      try {
        if (entry.request.actionType === 'claude' && exitCode === 0) {
          const hash = await this.autoCommit(
            entry.request.inputs.workspacePath ?? process.cwd(),
            entry.request,
          );
          commitHash = hash ?? undefined;
        }
      } catch (err) {
        this.emitOutput(executionId,
          `[LocalFamiliar] autoCommit error: ${err}\n`);
      }

      const response: WorkResponse = {
        requestId: entry.request.requestId,
        actionId: entry.request.actionId,
        status: exitCode === 0 ? 'completed' : 'failed',
        outputs: {
          exitCode,
          commitHash,
          claudeSessionId: entry.claudeSessionId,
        },
      };
      this.emitComplete(executionId, response);
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
