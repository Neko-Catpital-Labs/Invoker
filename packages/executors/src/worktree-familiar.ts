import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { FamiliarHandle, PersistedTaskMeta, TerminalSpec } from './familiar.js';
import { BaseFamiliar, type BaseEntry } from './base-familiar.js';
import { RepoPool } from './repo-pool.js';
import { killProcessGroup, cleanElectronEnv, SIGKILL_TIMEOUT_MS } from './process-utils.js';
import { DEFAULT_WORKTREE_PROVISION_COMMAND } from './default-worktree-provision-command.js';
import { computeBranchHash, bashMergeUpstreams, parseMergeError } from './branch-utils.js';
import { RESTART_TO_BRANCH_TRACE } from './exec-trace.js';

// Re-export for backward compatibility
export { computeBranchHash } from './branch-utils.js';

export interface WorktreeFamiliarConfig {
  /** Directory where worktrees are created. */
  worktreeBaseDir?: string;
  /** Directory for RepoPool clone cache. Required. */
  cacheDir: string;
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
 * Familiar implementation that runs tasks inside git worktrees.
 *
 * Each experiment gets its own worktree directory and branch, providing
 * filesystem-level isolation without the overhead of Docker containers.
 */
export class WorktreeFamiliar extends BaseFamiliar<WorktreeEntry> {
  readonly type = 'worktree';

  private readonly worktreeBaseDir: string;
  private readonly claudeCommand: string;
  private pool: RepoPool;

  constructor(config: WorktreeFamiliarConfig) {
    super();
    this.claudeCommand = config.claudeCommand ?? 'claude';
    this.worktreeBaseDir =
      config.worktreeBaseDir ?? resolve(homedir(), '.invoker', 'worktrees');
    this.pool = new RepoPool({
      cacheDir: config.cacheDir,
      maxWorktrees: config.maxWorktrees,
      worktreeBaseDir: this.worktreeBaseDir,
    });
  }

  async start(request: WorkRequest): Promise<FamiliarHandle> {
    const repoUrl = request.inputs.repoUrl;
    if (!repoUrl) {
      throw new Error(
        `WorktreeFamiliar.start(): missing repoUrl for task "${request.actionId}". ` +
        `Plans must declare a repoUrl.`,
      );
    }
    console.log(
      `${RESTART_TO_BRANCH_TRACE} WorktreeFamiliar.start() actionId=${request.actionId} repoUrl=${repoUrl}`,
    );
    await this.ensureGitAvailable();
    const handle = this.createHandle(request);
    const executionId = handle.executionId;
    const t0 = Date.now();
    const log = (step: string) => console.log(`[WorktreeFamiliar] start task=${request.actionId} step=${step} elapsed=${Date.now() - t0}ms`);

    // Resolve base ref from pool clone (ensureClone does the fetch)
    const clonePath = await this.pool.ensureClone(repoUrl);
    const baseRef = request.inputs.baseBranch ?? 'HEAD';
    log(`rev-parse ${baseRef} begin`);
    const baseHead = await this.execGitSimple(['rev-parse', baseRef], clonePath);
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
    console.log(`[WorktreeFamiliar] branch=${branch} hash=${hash}`);

    // -- Reconciliation: no process, immediate needs_input --
    if (request.actionType === 'reconciliation') {
      const worktreeDir = `${this.worktreeBaseDir}/${executionId}`;
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
      this.scheduleReconciliationResponse(handle.executionId);
      return handle;
    }

    // -- Always use RepoPool --
    console.log(
      `${RESTART_TO_BRANCH_TRACE} WorktreeFamiliar.start() actionId=${request.actionId} → RepoPool path`,
    );
    const acquired = await this.pool.acquireWorktree(repoUrl, branch);

    this.cleanStaleLocks(acquired.worktreePath);

    // Merge upstream dependency branches (pool already did preserve-or-reset)
    const poolUpstreams = request.inputs.upstreamBranches ?? [];
    if (poolUpstreams.length > 0) {
      try {
        const mergeScript = bashMergeUpstreams({
          worktreeDir: acquired.worktreePath,
          upstreamBranches: poolUpstreams,
          skipAncestors: true,
        });
        await this.runBash(mergeScript, acquired.worktreePath);
      } catch (err: any) {
        const exitCode = err.exitCode ?? 1;
        const stderr = err.stderr ?? err.message ?? '';
        if (exitCode === 31) {
          const parsed = parseMergeError(exitCode, stderr);
          const entry: WorktreeEntry = {
            process: null, request, worktreeDir: acquired.worktreePath, branch,
            outputListeners: new Set(), outputBuffer: [],
            completeListeners: new Set(), heartbeatListeners: new Set(),
            completed: true,
            poolRelease: acquired.release,
          };
          this.registerEntry(handle, entry);
          handle.workspacePath = acquired.worktreePath;
          handle.branch = acquired.branch;
          const response: WorkResponse = {
            requestId: request.requestId,
            actionId: request.actionId,
            status: 'failed',
            outputs: {
              exitCode: 1,
              error: JSON.stringify({
                type: 'merge_conflict',
                failedBranch: parsed.failedBranch,
                conflictFiles: parsed.conflictFiles,
              }),
            },
          };
          this.emitComplete(handle.executionId, response);
          return handle;
        }
        throw err;
      }
    }

    // No-command tasks: complete immediately after branch setup
    if (!request.inputs.command && !request.inputs.prompt) {
      const entry: WorktreeEntry = {
        process: null, request, worktreeDir: acquired.worktreePath, branch,
        outputListeners: new Set(), outputBuffer: [],
        completeListeners: new Set(), heartbeatListeners: new Set(),
        completed: false,
        poolRelease: acquired.release,
      };
      this.registerEntry(handle, entry);
      handle.workspacePath = acquired.worktreePath;
      handle.branch = acquired.branch;
      await this.handleProcessExit(executionId, request, acquired.worktreePath, 0, { branch });
      return handle;
    }

    try {
      await this.provisionWorktree(acquired.worktreePath);
    } catch (err) {
      await acquired.release();
      throw err;
    }

    const { cmd, args, claudeSessionId } = this.buildCommandAndArgs(request, this.claudeCommand);

    const child = spawn(cmd, args, {
      stdio: [request.actionType === 'claude' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      cwd: acquired.worktreePath,
      detached: true,
      env: cleanElectronEnv(),
    });

    // Register error handler IMMEDIATELY to catch synchronous spawn failures
    child.on('error', (err) => {
      console.log(`[WorktreeFamiliar] child process spawn error: ${err.message}`);
      const response: WorkResponse = {
        requestId: request.requestId,
        actionId: request.actionId,
        status: 'failed',
        outputs: {
          exitCode: 1,
          error: `Failed to spawn command: ${err.message}`,
        },
      };
      this.emitComplete(executionId, response);
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
      const exitCode = code ?? (signal ? 1 : 0);
      await this.handleProcessExit(executionId, request, acquired.worktreePath, exitCode, {
        signal,
        branch,
        claudeSessionId: entry.claudeSessionId,
      });
      this.entries.delete(executionId);
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
      return { command: 'claude', args: ['--resume', entry.claudeSessionId, '--dangerously-skip-permissions'], cwd: entry.worktreeDir };
    }
    return { cwd: entry.worktreeDir };
  }

  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec {
    console.log(`[WorktreeFamiliar] getRestoredTerminalSpec task="${meta.taskId}" workspacePath="${meta.workspacePath ?? 'none'}" sessionId="${meta.claudeSessionId ?? 'none'}"`);
    if (meta.workspacePath && !existsSync(meta.workspacePath)) {
      console.log(`[WorktreeFamiliar] getRestoredTerminalSpec task="${meta.taskId}" — worktree path does NOT exist: ${meta.workspacePath}`);
      // Fall back to finding the worktree by branch via git worktree list
      const recovered = meta.branch ? this.findWorktreeByBranch(meta.branch) : undefined;
      if (recovered) {
        console.log(`[WorktreeFamiliar] getRestoredTerminalSpec task="${meta.taskId}" — recovered worktree by branch: ${recovered}`);
        meta = { ...meta, workspacePath: recovered };
      } else {
        throw new Error(
          `Worktree ${meta.workspacePath} no longer exists for task ${meta.taskId}. It may have been cleaned up.`,
        );
      }
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
    if (meta.branch) {
      // workspacePath is already a worktree — just checkout the branch there.
      const spec = {
        command: 'bash',
        args: ['-c', `git checkout '${meta.branch}' 2>/dev/null; exec bash`],
        cwd: meta.workspacePath,
      };
      console.log(`[WorktreeFamiliar] getRestoredTerminalSpec task="${meta.taskId}" → checkout branch spec, branch="${meta.branch}" cwd="${spec.cwd}"`);
      return spec;
    }
    console.log(`[WorktreeFamiliar] getRestoredTerminalSpec task="${meta.taskId}" → cwd-only spec, cwd="${meta.workspacePath}"`);
    return { cwd: meta.workspacePath };
  }

  /**
   * Look up a worktree path by branch name.
   * Searches the worktreeBaseDir for a directory matching the sanitized branch name.
   * Returns the worktree directory if found, undefined otherwise.
   */
  private findWorktreeByBranch(branch: string): string | undefined {
    try {
      // The pool creates worktrees at {worktreeBaseDir}/{urlHash}/{sanitizedBranch}
      const sanitized = branch.replace(/\//g, '-');
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      for (const sub of readdirSync(this.worktreeBaseDir, { withFileTypes: true })) {
        if (sub.isDirectory()) {
          const candidate = join(this.worktreeBaseDir, sub.name, sanitized);
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch (err) {
      console.warn(`[WorktreeFamiliar] findWorktreeByBranch failed: ${err}`);
    }
    return undefined;
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

    this.entries.clear();
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

  private provisionWorktree(dir: string, executionId?: string): Promise<void> {
    console.log(`[WorktreeFamiliar] provisionWorktree begin dir=${dir}`);
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const cmd = `set -euo pipefail; ${DEFAULT_WORKTREE_PROVISION_COMMAND}`;
      const child = spawn('/bin/bash', ['-c', cmd], {
        cwd: dir,
        env: cleanElectronEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.log(`[WorktreeFamiliar] provisionWorktree spawned pid=${child.pid}`);
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString();
        stdout += text;
        console.log(`[WorktreeFamiliar] provision stdout: ${text.trimEnd()}`);
        if (executionId) this.emitOutput(executionId, text);
      });
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString();
        stderr += text;
        console.log(`[WorktreeFamiliar] provision stderr: ${text.trimEnd()}`);
        if (executionId) this.emitOutput(executionId, text);
      });
      child.on('error', (err) => {
        console.log(`[WorktreeFamiliar] provisionWorktree error: ${err.message}`);
        reject(new Error(`Failed to spawn provisioning process: ${err.message}`));
      });
      child.on('close', (code) => {
        console.log(`[WorktreeFamiliar] provisionWorktree finished dir=${dir} code=${code} elapsed=${Date.now() - t0}ms`);
        if (code === 0) resolve();
        else {
          const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
          reject(new Error(`Worktree provisioning failed in ${dir} (exit ${code}): ${combined}`));
        }
      });
    });
  }

}
