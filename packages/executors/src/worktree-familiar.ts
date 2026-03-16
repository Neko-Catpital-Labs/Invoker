import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { FamiliarHandle, PersistedTaskMeta, TerminalSpec } from './familiar.js';
import { BaseFamiliar, type BaseEntry } from './base-familiar.js';
import { RepoPool } from './repo-pool.js';

const SIGKILL_TIMEOUT_MS = 5_000;

/**
 * Merkle-style hash for content-addressable branch naming.
 * Inputs: task identity + command/prompt + upstream dependency commits + base branch HEAD.
 * When any input changes (e.g. master moves forward), the hash changes and a fresh branch is created.
 */
export function computeBranchHash(
  actionId: string,
  command: string | undefined,
  prompt: string | undefined,
  upstreamCommits: string[],
  baseHead: string,
  salt: string = '',
): string {
  const h = createHash('sha256');
  h.update(actionId);
  h.update(command ?? '');
  h.update(prompt ?? '');
  for (const c of [...upstreamCommits].sort()) h.update(c);
  h.update(baseHead);
  if (salt) h.update(salt);
  return h.digest('hex').slice(0, 8);
}

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
    const t0 = Date.now();
    const log = (step: string) => console.log(`[WorktreeFamiliar] start task=${request.actionId} step=${step} elapsed=${Date.now() - t0}ms`);

    const baseRef = request.inputs.baseBranch ?? 'HEAD';
    log(`rev-parse ${baseRef} begin`);
    const baseHead = await this.execGit(['rev-parse', baseRef], this.repoDir);
    log(`rev-parse ${baseRef} done`);
    const upstreamCommits = (request.inputs.upstreamContext ?? [])
      .map(c => c.commitHash)
      .filter((h): h is string => !!h);
    const hash = computeBranchHash(
      request.actionId,
      request.inputs.command,
      request.inputs.prompt,
      upstreamCommits,
      baseHead,
      request.inputs.salt,
    );
    const branch = `experiment/${request.actionId}-${hash}`;
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
        heartbeatListeners: new Set(),
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

      this.cleanStaleLocks(acquired.worktreePath);

      // Merge upstream dependency branches into the pool worktree
      await this.mergeUpstreamBranches(request.inputs.upstreamBranches, acquired.worktreePath);

      // Install dependencies so tasks can build/test in the worktree
      await this.provisionWorktree(acquired.worktreePath);

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
        heartbeatListeners: new Set(),
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

        let commitHash: string | undefined;
        let status: 'completed' | 'failed' = exitCode === 0 ? 'completed' : 'failed';
        try {
          const hash = await this.recordTaskResult(acquired.worktreePath, request, exitCode);
          commitHash = hash ?? undefined;
        } catch (err) {
          this.emitOutput(executionId,
            `[WorktreeFamiliar] post-exit error: ${err}\n`);
          if (exitCode === 0) {
            status = 'failed';
          }
        }

        const response: WorkResponse = {
          requestId: request.requestId,
          actionId: request.actionId,
          status,
          outputs: {
            exitCode: status === 'failed' && exitCode === 0 ? 1 : exitCode,
            summary: `branch=${branch} commit=${commitHash ?? 'unknown'}`,
            claudeSessionId: entry.claudeSessionId,
          },
        };
        this.emitComplete(executionId, response);
      });

      this.startHeartbeat(executionId, child);
      return handle;
    }

    // Clean up stale worktree references (e.g. from a previous crashed run)
    log('worktree prune begin');
    await this.execGit(['worktree', 'prune'], this.repoDir);
    log('worktree prune done');

    // Force-remove any existing worktree that holds this branch
    // (prune only removes references whose directories were deleted;
    //  this handles the case where the old directory still exists on disk)
    try {
      log('worktree list begin');
      const porcelain = await this.execGit(['worktree', 'list', '--porcelain'], this.repoDir);
      log('worktree list done');
      console.log(`[WorktreeFamiliar] worktree list found ${porcelain.split('worktree ').length - 1} entries for branch=${branch}`);
      const branchRef = `branch refs/heads/${branch}`;
      const lines = porcelain.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === branchRef) {
          for (let j = i - 1; j >= 0; j--) {
            if (lines[j].startsWith('worktree ')) {
              const oldPath = lines[j].slice('worktree '.length);
              console.log(`[WorktreeFamiliar] Force-removing stale worktree: ${oldPath} (branch=${branch})`);
              log('worktree remove --force begin');
              await this.execGit(['worktree', 'remove', '--force', oldPath], this.repoDir);
              log('worktree remove --force done');
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
    const startPoint = request.inputs.baseBranch ?? 'HEAD';
    try {
      log('worktree add -b begin');
      await this.execGit(
        ['worktree', 'add', '-b', branch, worktreeDir, startPoint],
        this.repoDir,
      );
      log('worktree add -b done');
    } catch (err) {
      // If the branch already exists, try without -b
      try {
        log('worktree add (no -b) begin');
        await this.execGit(
          ['worktree', 'add', worktreeDir, branch],
          this.repoDir,
        );
        log('worktree add (no -b) done');
      } catch (retryErr) {
        throw new Error(
          `Failed to create worktree: ${retryErr}. Original: ${err}`,
        );
      }
    }

    this.cleanStaleLocks(worktreeDir);

    // -- Merge upstream dependency branches into the worktree --
    log('mergeUpstreamBranches begin');
    await this.mergeUpstreamBranches(request.inputs.upstreamBranches, worktreeDir);
    log('mergeUpstreamBranches done');

    // -- Install dependencies so tasks can build/test in the worktree --
    log('provisionWorktree begin');
    await this.provisionWorktree(worktreeDir);
    log('provisionWorktree done');

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
    log(`spawn begin cmd=${cmd}`);
    const child = spawn(cmd, args, {
      stdio: [request.actionType === 'claude' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      cwd: worktreeDir,
      detached: true,
      env: cleanElectronEnv(),
    });
    log(`spawn done pid=${child.pid}`);

    const entry: WorktreeEntry = {
      process: child,
      request,
      worktreeDir,
      branch,
      outputListeners: new Set(),
      outputBuffer: [],
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
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

      let commitHash: string | undefined;
      let status: 'completed' | 'failed' = exitCode === 0 ? 'completed' : 'failed';
      try {
        const hash = await this.recordTaskResult(worktreeDir, request, exitCode);
        commitHash = hash ?? undefined;
      } catch (err) {
        this.emitOutput(executionId,
          `[WorktreeFamiliar] post-exit error: ${err}\n`);
        if (exitCode === 0) {
          status = 'failed';
        }
      }

      const response: WorkResponse = {
        requestId: request.requestId,
        actionId: request.actionId,
        status,
        outputs: {
          exitCode: status === 'failed' && exitCode === 0 ? 1 : exitCode,
          summary: `branch=${branch} commit=${commitHash ?? 'unknown'}`,
          claudeSessionId: entry.claudeSessionId,
        },
      };
      this.emitComplete(executionId, response);
    });

    this.startHeartbeat(executionId, child);
    log('startHeartbeat done — start() returning');
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

  private cleanStaleLocks(dir: string): void {
    const gitDir = join(dir, '.git');
    const lockFiles = ['index.lock', 'shallow.lock', 'HEAD.lock'];
    for (const lockFile of lockFiles) {
      const lockPath = join(gitDir, lockFile);
      if (existsSync(lockPath)) {
        console.warn(`[WorktreeFamiliar] Removing stale git lock: ${lockPath}`);
        try { unlinkSync(lockPath); } catch { /* race: already removed */ }
      }
    }
  }

  /**
   * Merge upstream dependency branches into a worktree.
   * Skips branches already in HEAD's ancestry. Aborts cleanly on conflict.
   */
  private async mergeUpstreamBranches(
    upstreamBranches: string[] | undefined,
    worktreeDir: string,
  ): Promise<void> {
    if (!upstreamBranches?.length) return;

    for (const upBranch of upstreamBranches) {
      // Skip if already an ancestor of HEAD (redundant merge)
      try {
        await this.execGit(['merge-base', '--is-ancestor', upBranch, 'HEAD'], worktreeDir);
        console.log(`[WorktreeFamiliar] Skipping merge of ${upBranch} — already ancestor of HEAD`);
        continue;
      } catch {
        // Not an ancestor — proceed with merge
      }

      // Verify the branch ref exists before attempting merge
      try {
        await this.execGit(['rev-parse', '--verify', upBranch], worktreeDir);
      } catch {
        throw new Error(
          `Upstream branch "${upBranch}" does not exist. ` +
          `The dependency task's branch may not be visible in this worktree.`,
        );
      }

      try {
        await this.execGit(
          ['merge', '--no-edit', '-m', `Merge upstream ${upBranch}`, upBranch],
          worktreeDir,
        );
      } catch (err) {
        // Abort the failed merge to leave worktree in a clean state
        try {
          await this.execGit(['merge', '--abort'], worktreeDir);
        } catch {
          // merge --abort can fail if there's nothing to abort
        }
        throw new Error(
          `Failed to merge upstream branch ${upBranch}: ${err}`,
        );
      }
    }
  }

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
        else {
          const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
          reject(new Error(`git ${args.join(' ')} failed (code ${code}): ${details}`));
        }
      });
    });
  }

  private provisionWorktree(dir: string): Promise<void> {
    console.log(`[WorktreeFamiliar] provisionWorktree begin dir=${dir}`);
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const cmd = 'pnpm install --frozen-lockfile && node scripts/rebuild-for-electron.js';
      const child = spawn('/bin/sh', ['-c', cmd], {
        cwd: dir,
        env: cleanElectronEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.log(`[WorktreeFamiliar] provisionWorktree spawned pid=${child.pid}`);
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => {
        console.log(`[WorktreeFamiliar] provision stdout: ${d.toString().trimEnd()}`);
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
        console.log(`[WorktreeFamiliar] provision stderr: ${d.toString().trimEnd()}`);
      });
      child.on('close', (code) => {
        console.log(`[WorktreeFamiliar] provisionWorktree finished dir=${dir} code=${code} elapsed=${Date.now() - t0}ms`);
        if (code === 0) resolve();
        else reject(new Error(`Worktree provisioning failed in ${dir} (exit ${code}): ${stderr.trim()}`));
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
