import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { FamiliarHandle, PersistedTaskMeta, TerminalSpec } from './familiar.js';
import { BaseFamiliar, type BaseEntry } from './base-familiar.js';
import { RepoPool } from './repo-pool.js';

const SIGKILL_TIMEOUT_MS = 5_000;

/** Strip Electron-specific env vars so child processes use the system Node.js. */
function cleanElectronEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

export interface WorktreeFamiliarConfig {
  /** Path to the main git repository. */
  repoDir: string;
  /** Directory where worktrees are created. Defaults to {repoDir}/.invoker/worktrees. */
  worktreeBaseDir?: string;
  /** Enable RepoPool: cache clones in this directory. When set, repoUrl in WorkRequest triggers pool usage. */
  cacheDir?: string;
  /** Maximum worktrees per cached repo. Default: 5. */
  maxWorktrees?: number;
  /** Command to invoke the Claude CLI. Defaults to 'claude'. */
  claudeCommand?: string;
}

interface WorktreeEntry extends BaseEntry {
  process: ChildProcess | null;
  worktreeDir: string;
  branch: string;
  /** Release function for pool-managed worktrees. */
  poolRelease?: () => Promise<void>;
  /** Claude session ID for resuming sessions. */
  claudeSessionId?: string;
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
    return child.kill(signal);
  }
}

/**
 * Familiar implementation that runs tasks inside git worktrees.
 *
 * Each experiment gets its own worktree directory and branch, providing
 * filesystem-level isolation without the overhead of Docker containers.
 */
export class WorktreeFamiliar extends BaseFamiliar<WorktreeEntry> {
  readonly type = 'worktree';

  private readonly repoDir: string;
  private readonly worktreeBaseDir: string;
  private readonly claudeCommand: string;
  private pool: RepoPool | null = null;

  constructor(config: WorktreeFamiliarConfig) {
    super();  
    this.repoDir = config.repoDir;
    this.claudeCommand = config.claudeCommand ?? 'claude';
    this.worktreeBaseDir =
      config.worktreeBaseDir ?? resolve(homedir(), '.invoker', 'worktrees');
    if (config.cacheDir) {
      this.pool = new RepoPool({
        cacheDir: config.cacheDir,
        maxWorktrees: config.maxWorktrees,
        worktreeBaseDir: this.worktreeBaseDir,
      });
    }
  }

  async start(request: WorkRequest): Promise<FamiliarHandle> {
    const handle = this.createHandle(request);
    const executionId = handle.executionId;

    const branch = `experiment/${request.actionId}`;
    const worktreeDir = `${this.worktreeBaseDir}/${executionId}`;

    // -- Reconciliation: no process, immediate needs_input --
    if (request.actionType === 'reconciliation') {
      const entry: WorktreeEntry = {
        process: null,
        request,
        worktreeDir,
        branch,
        outputListeners: new Set(),
        outputBuffer: [],
        completeListeners: new Set(),
        completed: false,
      };
      this.registerEntry(handle, entry);

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

    // -- Pool-based worktree (when repoUrl is provided and pool is available) --
    if (this.pool && request.inputs.repoUrl) {
      const acquired = await this.pool.acquireWorktree(request.inputs.repoUrl, branch);

      // Merge upstream dependency branches into the pool worktree
      if (request.inputs.upstreamBranches?.length) {
        for (const upBranch of request.inputs.upstreamBranches) {
          await this.execGit(['merge', '--no-edit', upBranch], acquired.worktreePath);
        }
      }

      // Determine what to run (same logic as below)
      let cmd: string;
      let args: string[];
      let claudeSessionId: string | undefined;
      if (request.actionType === 'command') {
        const command = request.inputs.command;
        if (!command) throw new Error('WorkRequest with actionType "command" must have inputs.command');
        cmd = '/bin/sh';
        args = ['-c', command];
      } else if (request.actionType === 'claude') {
        const session = this.prepareClaudeSession(request);
        claudeSessionId = session.sessionId;
        cmd = this.claudeCommand;
        args = session.cliArgs;
      } else {
        cmd = '/bin/sh';
        args = ['-c', 'echo "Unsupported action type"'];
      }

      const child = spawn(cmd, args, {
        stdio: [request.actionType === 'claude' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        cwd: acquired.worktreePath,
        detached: true,
        env: cleanElectronEnv(),
      });

      const entry: WorktreeEntry = {
        process: child,
        request,
        worktreeDir: acquired.worktreePath,
        branch: acquired.branch,
        outputListeners: new Set(),
        outputBuffer: [],
        completeListeners: new Set(),
        completed: false,
        poolRelease: acquired.release,
        claudeSessionId,
      };

      this.registerEntry(handle, entry);
      handle.workspacePath = acquired.worktreePath;
      handle.branch = acquired.branch;
      if (claudeSessionId) {
        handle.claudeSessionId = claudeSessionId;
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        this.emitOutput(executionId, chunk.toString());
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        this.emitOutput(executionId, chunk.toString());
      });

      child.on('close', async (code, signal) => {
        entry.completed = true;
        const exitCode = code ?? (signal ? 1 : 0);
        const signalInfo = signal ? ` signal=${signal}` : '';
        this.emitOutput(executionId,
          `[WorktreeFamiliar] Process exited: actionId=${request.actionId} exitCode=${exitCode}${signalInfo}\n`);

        let commitHash = 'unknown';
        try {
          await this.autoCommit(acquired.worktreePath, request.actionId, {
            prompt: request.inputs.prompt,
            upstreamContext: request.inputs.upstreamContext,
          });
          commitHash = await this.execGit(['rev-parse', 'HEAD'], acquired.worktreePath);
        } catch (err) {
          this.emitOutput(executionId,
            `[WorktreeFamiliar] post-exit error: ${err}\n`);
        }

        const response: WorkResponse = {
          requestId: request.requestId,
          actionId: request.actionId,
          status: exitCode === 0 ? 'completed' : 'failed',
          outputs: {
            exitCode,
            summary: `branch=${branch} commit=${commitHash}`,
            claudeSessionId: entry.claudeSessionId,
          },
        };
        this.emitComplete(executionId, response);
      });

      this.startHeartbeat(executionId, child);
      return handle;
    }

    // Clean up stale worktree references (e.g. from a previous crashed run)
    await this.execGit(['worktree', 'prune'], this.repoDir);

    // Force-remove any existing worktree that holds this branch
    // (prune only removes references whose directories were deleted;
    //  this handles the case where the old directory still exists on disk)
    try {
      const porcelain = await this.execGit(['worktree', 'list', '--porcelain'], this.repoDir);
      console.log(`[WorktreeFamiliar] worktree list found ${porcelain.split('worktree ').length - 1} entries for branch=${branch}`);
      const branchRef = `branch refs/heads/${branch}`;
      const lines = porcelain.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === branchRef) {
          for (let j = i - 1; j >= 0; j--) {
            if (lines[j].startsWith('worktree ')) {
              const oldPath = lines[j].slice('worktree '.length);
              console.log(`[WorktreeFamiliar] Force-removing stale worktree: ${oldPath} (branch=${branch})`);
              await this.execGit(['worktree', 'remove', '--force', oldPath], this.repoDir);
              console.log(`[WorktreeFamiliar] Successfully removed stale worktree: ${oldPath}`);
              break;
            }
          }
          break;
        }
      }
    } catch (err) {
      console.warn(`[WorktreeFamiliar] Force-remove failed (will attempt add anyway):`, err);
    }

    // -- Create the worktree with a new branch --
    try {
      await this.execGit(
        ['worktree', 'add', '-b', branch, worktreeDir],
        this.repoDir,
      );
    } catch (err) {
      // If the branch already exists, try without -b
      try {
        await this.execGit(
          ['worktree', 'add', worktreeDir, branch],
          this.repoDir,
        );
      } catch (retryErr) {
        throw new Error(
          `Failed to create worktree: ${retryErr}. Original: ${err}`,
        );
      }
    }

    // -- Merge upstream dependency branches into the worktree --
    if (request.inputs.upstreamBranches?.length) {
      for (const upBranch of request.inputs.upstreamBranches) {
        await this.execGit(['merge', '--no-edit', upBranch], worktreeDir);
      }
    }

    // -- Determine what to run --
    let cmd: string;
    let args: string[];
    let claudeSessionId: string | undefined;

    if (request.actionType === 'command') {
      const command = request.inputs.command;
      if (!command) {
        throw new Error(
          'WorkRequest with actionType "command" must have inputs.command',
        );
      }
      cmd = '/bin/sh';
      args = ['-c', command];
    } else if (request.actionType === 'claude') {
      const session = this.prepareClaudeSession(request);
      claudeSessionId = session.sessionId;
      cmd = this.claudeCommand;
      args = session.cliArgs;
    } else {
      cmd = '/bin/sh';
      args = ['-c', 'echo "Unsupported action type"'];
    }

    // -- Spawn the process in the worktree directory --
    const child = spawn(cmd, args, {
      stdio: [request.actionType === 'claude' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      cwd: worktreeDir,
      detached: true,
      env: cleanElectronEnv(),
    });

    const entry: WorktreeEntry = {
      process: child,
      request,
      worktreeDir,
      branch,
      outputListeners: new Set(),
      outputBuffer: [],
      completeListeners: new Set(),
      completed: false,
      claudeSessionId,
    };

    this.registerEntry(handle, entry);
    handle.workspacePath = worktreeDir;
    handle.branch = branch;
    if (claudeSessionId) {
      handle.claudeSessionId = claudeSessionId;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      this.emitOutput(executionId, chunk.toString());
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.emitOutput(executionId, chunk.toString());
    });

    child.on('close', async (code, signal) => {
      entry.completed = true;
      const exitCode = code ?? (signal ? 1 : 0);
      const signalInfo = signal ? ` signal=${signal}` : '';
      this.emitOutput(executionId,
        `[WorktreeFamiliar] Process exited: actionId=${request.actionId} exitCode=${exitCode}${signalInfo}\n`);

      let commitHash = 'unknown';
      try {
        await this.autoCommit(worktreeDir, request.actionId, {
          prompt: request.inputs.prompt,
          upstreamContext: request.inputs.upstreamContext,
        });
        commitHash = await this.execGit(['rev-parse', 'HEAD'], worktreeDir);
      } catch (err) {
        this.emitOutput(executionId,
          `[WorktreeFamiliar] post-exit error: ${err}\n`);
      }

      const response: WorkResponse = {
        requestId: request.requestId,
        actionId: request.actionId,
        status: exitCode === 0 ? 'completed' : 'failed',
        outputs: {
          exitCode,
          summary: `branch=${branch} commit=${commitHash}`,
          claudeSessionId: entry.claudeSessionId,
        },
      };
      this.emitComplete(executionId, response);
    });

    this.startHeartbeat(executionId, child);
    return handle;
  }

  async kill(handle: FamiliarHandle): Promise<void> {
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.completed) return;

    if (!entry.process) return;

    await new Promise<void>((resolve) => {
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

      if (entry.completed) {
        clearTimeout(killTimer);
        resolve();
        return;
      }

      killProcessGroup(child, 'SIGTERM');
    });

    // Remove the worktree after killing
    await this.removeWorktree(entry);
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
      return { command: 'claude', args: ['--resume', entry.claudeSessionId], cwd: entry.worktreeDir };
    }
    return { cwd: entry.worktreeDir };
  }

  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec {
    console.log(`[WorktreeFamiliar] getRestoredTerminalSpec task="${meta.taskId}" workspacePath="${meta.workspacePath ?? 'none'}" sessionId="${meta.claudeSessionId ?? 'none'}"`);
    if (meta.workspacePath && !existsSync(meta.workspacePath)) {
      console.log(`[WorktreeFamiliar] getRestoredTerminalSpec task="${meta.taskId}" — worktree path does NOT exist: ${meta.workspacePath}`);
      throw new Error(
        `Worktree ${meta.workspacePath} no longer exists for task ${meta.taskId}. It may have been cleaned up.`,
      );
    }
    if (meta.workspacePath) {
      console.log(`[WorktreeFamiliar] getRestoredTerminalSpec task="${meta.taskId}" — worktree path exists: ${meta.workspacePath}`);
    }
    if (meta.claudeSessionId) {
      const spec = {
        command: 'claude',
        args: ['--resume', meta.claudeSessionId, '--dangerously-skip-permissions'],
        cwd: meta.workspacePath,
      };
      console.log(`[WorktreeFamiliar] getRestoredTerminalSpec task="${meta.taskId}" → claude --resume spec, cwd="${spec.cwd}"`);
      return spec;
    }
    console.log(`[WorktreeFamiliar] getRestoredTerminalSpec task="${meta.taskId}" → cwd-only spec, cwd="${meta.workspacePath}"`);
    return { cwd: meta.workspacePath };
  }

  async destroyAll(): Promise<void> {
    const allEntries = Array.from(this.entries.entries());
    const closePromises: Promise<void>[] = [];

    for (const [_executionId, entry] of allEntries) {
      if (!entry.completed && entry.process) {
        closePromises.push(
          new Promise<void>((resolve) => {
            entry.process!.on('close', () => resolve());

            killProcessGroup(entry.process!, 'SIGTERM');

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

    // Remove all worktrees
    const removePromises: Promise<void>[] = [];
    for (const [, entry] of allEntries) {
      removePromises.push(this.removeWorktree(entry));
    }
    await Promise.allSettled(removePromises);

    this.entries.clear();

    // Destroy pool if present
    if (this.pool) {
      await this.pool.destroyAll();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`git ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
      });
    });
  }

  private async removeWorktree(entry: WorktreeEntry): Promise<void> {
    if (entry.poolRelease) {
      await entry.poolRelease();
      return;
    }
    try {
      await this.execGit(
        ['worktree', 'remove', '--force', entry.worktreeDir],
        this.repoDir,
      );
    } catch {
      // Worktree may already be removed or directory missing; prune instead.
      try {
        await this.execGit(['worktree', 'prune'], this.repoDir);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
