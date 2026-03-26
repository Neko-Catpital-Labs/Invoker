import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { Familiar, FamiliarHandle, PersistedTaskMeta, TerminalSpec, Unsubscribe } from './familiar.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface BaseEntry {
  request: WorkRequest;
  outputListeners: Set<(data: string) => void>;
  completeListeners: Set<(response: WorkResponse) => void>;
  heartbeatListeners: Set<(taskId: string) => void>;
  completed: boolean;
  /** Buffered output chunks for replay when new listeners are added. */
  outputBuffer: string[];
  /** Stored completion response for replay when listeners register after completion. */
  completionResponse?: WorkResponse;
  /** Heartbeat timer handle for orphan detection. */
  heartbeatTimer?: ReturnType<typeof setInterval>;
  /** Timestamp when the heartbeat was started, for max duration enforcement. */
  heartbeatStartedAt?: number;
}

export interface ClaudeSessionParams {
  sessionId: string;
  cliArgs: string[];
  fullPrompt: string;
}

export interface SetupBranchOptions {
  /** Override default branch name (default: `invoker/{actionId}`). */
  branchName?: string;
  /** Override the base ref computation. */
  base?: string;
  /** If set, use `git worktree add` instead of `git checkout`. Value = worktree dir path. */
  worktreeDir?: string;
  /** Skip upstream branch merging (default: false). Caller handles upstream merging separately. */
  skipUpstreams?: boolean;
}

export class MergeConflictError extends Error {
  constructor(
    public readonly failedBranch: string,
    public readonly conflictFiles: string[],
    cause?: unknown,
  ) {
    super(`Merge conflict merging ${failedBranch}: ${conflictFiles.join(', ')}`);
    this.name = 'MergeConflictError';
    if (cause instanceof Error) this.cause = cause;
  }
}

export abstract class BaseFamiliar<TEntry extends BaseEntry> implements Familiar {
  abstract readonly type: string;
  protected entries = new Map<string, TEntry>();
  protected heartbeatIntervalMs: number;
  protected maxDurationMs: number;

  constructor(heartbeatIntervalMs?: number, maxDurationMs?: number) {
    this.heartbeatIntervalMs = heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxDurationMs = maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  }

  protected createHandle(request: WorkRequest): FamiliarHandle {
    return { executionId: randomUUID(), taskId: request.actionId };
  }

  protected registerEntry(handle: FamiliarHandle, entry: TEntry): void {
    this.entries.set(handle.executionId, entry);
  }

  protected getEntry(handle: FamiliarHandle): TEntry | undefined {
    return this.entries.get(handle.executionId);
  }

  protected emitOutput(executionId: string, data: string): void {
    const entry = this.entries.get(executionId);
    if (!entry) return;
    entry.outputBuffer.push(data);
    for (const cb of entry.outputListeners) {
      cb(data);
    }
  }

  protected emitHeartbeat(executionId: string): void {
    const entry = this.entries.get(executionId);
    if (!entry) return;
    for (const cb of entry.heartbeatListeners) {
      cb(entry.request.actionId);
    }
  }

  protected emitComplete(executionId: string, response: WorkResponse): void {
    const entry = this.entries.get(executionId);
    if (!entry) return;
    if (entry.completionResponse) return;
    if (entry.heartbeatTimer) {
      clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = undefined;
    }
    entry.completed = true;
    entry.completionResponse = response;
    for (const cb of entry.completeListeners) {
      cb(response);
    }
  }

  /**
   * Start a periodic heartbeat that detects orphaned processes: the child
   * has exited but the close handler failed to fire completion.
   */
  protected startHeartbeat(executionId: string, child: ChildProcess): void {
    const entry = this.entries.get(executionId);
    if (!entry) return;

    entry.heartbeatStartedAt = Date.now();

    entry.heartbeatTimer = setInterval(() => {
      if (entry.completed) {
        clearInterval(entry.heartbeatTimer);
        entry.heartbeatTimer = undefined;
        return;
      }

      if (child.exitCode !== null || child.killed) {
        clearInterval(entry.heartbeatTimer);
        entry.heartbeatTimer = undefined;

        const exitCode = child.exitCode ?? 1;
        this.emitOutput(executionId,
          `[${this.type}] Heartbeat detected orphaned process: actionId=${entry.request.actionId} exitCode=${exitCode}\n`);

        const response: WorkResponse = {
          requestId: entry.request.requestId,
          actionId: entry.request.actionId,
          status: 'failed',
          outputs: {
            exitCode,
            error: `Process exited but completion was not reported (heartbeat recovery)`,
          },
        };
        this.emitComplete(executionId, response);
        return;
      }

      const elapsed = Date.now() - (entry.heartbeatStartedAt ?? Date.now());
      if (this.maxDurationMs > 0 && elapsed > this.maxDurationMs) {
        console.warn(`[${this.type}] Task ${entry.request.actionId} exceeded max duration (${Math.round(elapsed / 1000)}s), killing`);
        this.emitOutput(executionId,
          `[${this.type}] Process exceeded max duration of ${Math.round(this.maxDurationMs / 1000)}s, sending SIGTERM\n`);
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        return;
      }

      this.emitHeartbeat(executionId);
    }, this.heartbeatIntervalMs);
  }

  onOutput(handle: FamiliarHandle, cb: (data: string) => void): Unsubscribe {
    const entry = this.entries.get(handle.executionId);
    if (!entry) return () => {};
    // Replay buffered output so late subscribers don't miss early data
    for (const chunk of entry.outputBuffer) {
      cb(chunk);
    }
    entry.outputListeners.add(cb);
    return () => { entry.outputListeners.delete(cb); };
  }

  onComplete(handle: FamiliarHandle, cb: (response: WorkResponse) => void): Unsubscribe {
    const entry = this.entries.get(handle.executionId);
    if (!entry) return () => {};
    // Replay if already completed
    if (entry.completionResponse) {
      cb(entry.completionResponse);
    }
    entry.completeListeners.add(cb);
    return () => { entry.completeListeners.delete(cb); };
  }

  onHeartbeat(handle: FamiliarHandle, cb: (taskId: string) => void): Unsubscribe {
    const entry = this.entries.get(handle.executionId);
    if (!entry) return () => {};
    entry.heartbeatListeners.add(cb);
    return () => { entry.heartbeatListeners.delete(cb); };
  }

  /**
   * Auto-commit all changes in a git working directory.
   * Returns the commit hash if changes were committed, null otherwise.
   */
  protected async autoCommit(
    cwd: string,
    request: WorkRequest,
  ): Promise<string | null> {
    try {
      await this.execGitSimple(['rev-parse', '--is-inside-work-tree'], cwd);
      await this.execGitSimple(['add', '-A'], cwd);

      try {
        await this.execGitSimple(['diff', '--cached', '--quiet'], cwd);
        return null;
      } catch {
        // There are staged changes — commit
      }

      const message = this.buildCommitMessage(request);
      await this.execGitSimple(['commit', '-m', message], cwd);
      const hash = await this.execGitSimple(['rev-parse', 'HEAD'], cwd);
      return hash.trim();
    } catch {
      return null;
    }
  }

  /**
   * Create or check out a feature branch for the current task.
   * If the branch doesn't exist, creates it from HEAD. If it exists, checks it out.
   * Silently skips if not in a git repo.
   */
  protected async ensureFeatureBranch(
    cwd: string,
    branchName: string,
  ): Promise<void> {
    try {
      await this.execGitSimple(['rev-parse', '--is-inside-work-tree'], cwd);

      try {
        await this.execGitSimple(['rev-parse', '--verify', branchName], cwd);
        // Branch exists, check it out
        await this.execGitSimple(['checkout', branchName], cwd);
      } catch {
        // Branch doesn't exist, create from HEAD
        await this.execGitSimple(['checkout', '-b', branchName], cwd);
      }
    } catch {
      // Not a git repo, silently skip
    }
  }

  protected buildCommitMessage(request: WorkRequest): string {
    const { actionId, inputs } = request;
    const headline = inputs.description
      ? `invoker: ${actionId} — ${inputs.description}`
      : `invoker: ${actionId}`;

    const parts = [headline];

    if (inputs.upstreamContext?.length) {
      const lines = inputs.upstreamContext.map(ctx => {
        const hash = ctx.commitHash ? ` (${ctx.commitHash.slice(0, 7)})` : '';
        return `  ${ctx.taskId}${hash}: ${ctx.description}`;
      });
      parts.push(`\nContext:\n${lines.join('\n')}`);
    }

    if (inputs.alternatives?.length) {
      const lines = inputs.alternatives.map(alt => {
        const hash = alt.commitHash ? ` ${alt.commitHash.slice(0, 7)}` : '';
        const branch = alt.branch ? ` (${alt.branch}` : ' (';
        const status = alt.status === 'failed'
          ? `failed${alt.exitCode !== undefined ? `, exit ${alt.exitCode}` : ''}`
          : alt.status;
        const suffix = alt.selected ? '  [selected]' : '';
        const summary = alt.summary ? `: ${alt.summary}` : '';
        return `  - ${alt.taskId}${hash}${branch}, ${status})${summary}${suffix}`;
      });
      parts.push(`\nAlternatives Considered:\n${lines.join('\n')}`);
    }

    if (inputs.description) {
      parts.push(`\nSolution:\n  ${inputs.description}`);
    }

    return parts.join('\n');
  }

  private static gitAvailableChecked = false;

  /** @internal — exposed for testing only */
  static resetGitAvailableCheck(): void {
    BaseFamiliar.gitAvailableChecked = false;
  }

  protected async ensureGitAvailable(): Promise<void> {
    if (BaseFamiliar.gitAvailableChecked) return;
    try {
      await this.execGitSimple(['--version'], process.cwd());
      BaseFamiliar.gitAvailableChecked = true;
    } catch (err) {
      throw new Error(
        `git is not available on PATH. Install git and ensure it is in your shell PATH.\n` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  protected execGitSimple(args: string[], cwd: string): Promise<string> {
    const stack = new Error().stack;
    const callerFrames = stack?.split('\n').slice(1, 5).map(l => l.trim()).join('\n    ') ?? '(no stack)';
    console.log(`[git-trace] git ${args.join(' ')}  cwd=${cwd}\n    ${callerFrames}`);
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (err) => {
        reject(new Error(`Failed to spawn git: ${err.message}`));
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

  protected async buildUpstreamMergeMessage(branch: string, cwd: string): Promise<string> {
    try {
      const tipMsg = (await this.execGitSimple(['log', '--first-parent', '--no-merges', '-1', '--format=%B', branch], cwd)).trim();
      const firstLine = tipMsg.split('\n')[0];
      const desc = firstLine.includes(' — ') ? firstLine.split(' — ').slice(1).join(' — ') : '';
      const headline = desc ? `Merge upstream ${branch} — ${desc}` : `Merge upstream ${branch}`;
      const body = tipMsg.split('\n').slice(1).join('\n').trim();
      return body ? `${headline}\n\n${body}` : headline;
    } catch {
      return `Merge upstream ${branch}`;
    }
  }

  // ── Shared branch lifecycle ────────────────────────────────

  /**
   * Create a task-specific branch based off the upstream dependency's branch.
   * The upstream branch carries transitive history by construction, so no
   * explicit merging is needed for linear chains. For DAG fan-in (multiple
   * upstreams), additional branches are merged after checkout.
   *
   * Sets `handle.branch` and returns the original branch name for restoration.
   * Returns undefined if not in a git repo or git operations fail.
   */
  protected async setupTaskBranch(
    cwd: string,
    request: WorkRequest,
    handle: FamiliarHandle,
    opts?: SetupBranchOptions,
  ): Promise<string | undefined> {
    try {
      const branchName = opts?.branchName ?? `invoker/${request.actionId}`;
      const upstreams = request.inputs.upstreamBranches ?? [];
      const base = opts?.base ?? upstreams[0] ?? request.inputs.baseBranch ?? 'HEAD';
      const mergeCwd = opts?.worktreeDir ?? cwd;

      // Worktrees don't need original branch tracking (they're separate checkouts)
      let originalBranch: string | undefined;
      if (!opts?.worktreeDir) {
        originalBranch = (await this.execGitSimple(['branch', '--show-current'], cwd)).trim();
      }

      // If the task branch already exists and has commits ahead of the base,
      // preserve it (e.g., AI fix or manual commit) and merge the base in.
      // Otherwise, force-create from the base for a clean start.
      let preserved = false;
      try {
        await this.execGitSimple(['rev-parse', '--verify', branchName], cwd);
        // Resolve base to concrete SHA so rev-list comparison is unambiguous
        const baseSha = (await this.execGitSimple(['rev-parse', base], cwd)).trim();
        const aheadCount = (await this.execGitSimple(
          ['rev-list', '--count', `${baseSha}..${branchName}`], cwd,
        )).trim();
        if (parseInt(aheadCount, 10) > 0) {
          console.log(`[setupTaskBranch] PRESERVING ${branchName} (${aheadCount} commits ahead of ${base})`);
          if (opts?.worktreeDir) {
            // Worktree mode: attach the existing branch without resetting it
            await this.execGitSimple(
              ['worktree', 'add', opts.worktreeDir, branchName], cwd,
            );
            await this.execGitSimple(['merge', '--no-edit', baseSha], opts.worktreeDir);
          } else {
            await this.execGitSimple(['checkout', branchName], cwd);
            await this.execGitSimple(['merge', '--no-edit', base], cwd);
          }
          preserved = true;
        }
      } catch {
        // Branch doesn't exist or rev-list failed — fall through to force-create
      }

      if (!preserved) {
        console.log(`[setupTaskBranch] FORCE-RESET ${branchName} → ${base} (no commits ahead or branch did not exist)`);
        if (opts?.worktreeDir) {
          await this.execGitSimple(
            ['worktree', 'add', '-B', branchName, opts.worktreeDir, base], cwd,
          );
        } else {
          await this.execGitSimple(['checkout', '-B', branchName, base], cwd);
        }
      }

      if (!opts?.skipUpstreams) {
        for (const ub of upstreams.slice(1)) {
          try {
            const mergeMsg = await this.buildUpstreamMergeMessage(ub, mergeCwd);
            await this.execGitSimple(['merge', '--no-edit', '-m', mergeMsg, ub], mergeCwd);
          } catch (err) {
            let conflictFiles: string[] = [];
            try {
              const raw = await this.execGitSimple(['diff', '--name-only', '--diff-filter=U'], mergeCwd);
              conflictFiles = raw.split('\n').filter(Boolean);
            } catch { /* best effort */ }

            try {
              await this.execGitSimple(['merge', '--abort'], mergeCwd);
            } catch {
              // merge --abort can fail if there's nothing to abort
            }
            throw new MergeConflictError(ub, conflictFiles, err);
          }
        }
      }

      handle.branch = branchName;
      return originalBranch;
    } catch (err) {
      if (err instanceof MergeConflictError) {
        throw err;
      }
      // In worktree mode, creation failure is fatal — re-throw
      if (opts?.worktreeDir) {
        throw err;
      }
      return undefined;
    }
  }

  /**
   * Record the task result as a commit. Calls autoCommit first; if there are
   * no file changes (common for command tasks), creates an empty commit with
   * the command/prompt and exit code. Returns the commit hash, or null on failure.
   */
  protected async recordTaskResult(
    cwd: string,
    request: WorkRequest,
    exitCode: number,
  ): Promise<string | null> {
    try {
      const hash = await this.autoCommit(cwd, request);
      if (hash) return hash;

      const message = this.buildResultCommitMessage(request, exitCode);
      await this.execGitSimple(['commit', '--allow-empty', '-m', message], cwd);
      return (await this.execGitSimple(['rev-parse', 'HEAD'], cwd)).trim();
    } catch {
      return null;
    }
  }

  /**
   * Restore the original branch after task completion.
   * No-op if originalBranch is undefined (e.g., not in a git repo).
   */
  protected async restoreBranch(cwd: string, originalBranch: string | undefined): Promise<void> {
    if (!originalBranch) return;
    try {
      await this.execGitSimple(['checkout', originalBranch], cwd);
    } catch { /* best effort */ }
  }

  // ── Pre/post sync hooks ──────────────────────────────────

  /**
   * Fetch from remote before starting a task.
   * Errors are logged but non-fatal so tasks can still run against local state.
   */
  protected async syncFromRemote(cwd: string, executionId?: string): Promise<void> {
    try {
      await this.execGitSimple(['fetch', 'origin'], cwd);
    } catch (err) {
      const msg = `[${this.type}] syncFromRemote failed: ${err}\n`;
      console.warn(msg);
      if (executionId) this.emitOutput(executionId, msg);
    }
  }

  /**
   * Push task branch to remote after completion.
   * Errors are logged but non-fatal.
   */
  protected async pushBranchToRemote(cwd: string, branch: string, executionId?: string): Promise<void> {
    try {
      await this.execGitSimple(['push', '-u', 'origin', branch], cwd);
    } catch (err) {
      const msg = `[${this.type}] pushBranchToRemote failed for ${branch}: ${err}\n`;
      console.warn(msg);
      if (executionId) this.emitOutput(executionId, msg);
    }
  }

  // ── Shared command building ─────────────────────────────

  /**
   * Build command, args, and optional Claude session from a WorkRequest.
   * Shared by WorktreeFamiliar and other familiars.
   */
  protected buildCommandAndArgs(
    request: WorkRequest,
    claudeCommand: string = 'claude',
  ): { cmd: string; args: string[]; claudeSessionId?: string; fullPrompt?: string } {
    if (request.actionType === 'command') {
      const command = request.inputs.command;
      if (!command) throw new Error('WorkRequest with actionType "command" must have inputs.command');
      return { cmd: '/bin/bash', args: ['-c', command] };
    }
    if (request.actionType === 'claude') {
      const session = this.prepareClaudeSession(request);
      return { cmd: claudeCommand, args: session.cliArgs, claudeSessionId: session.sessionId, fullPrompt: session.fullPrompt };
    }
    return { cmd: '/bin/bash', args: ['-c', 'echo "Unsupported action type"'] };
  }

  /**
   * Emit a deferred reconciliation response (needs_input) for reconciliation tasks.
   * Uses setTimeout(0) so the caller can register onComplete listeners first.
   */
  protected scheduleReconciliationResponse(executionId: string): void {
    setTimeout(() => {
      const entry = this.entries.get(executionId);
      if (!entry) return;
      const response: WorkResponse = {
        requestId: entry.request.requestId,
        actionId: entry.request.actionId,
        status: 'needs_input',
        outputs: { summary: 'Select winning experiment' },
      };
      this.emitComplete(executionId, response);
    }, 0);
  }

  /**
   * Shared close/exit handler: record result, push to remote, restore branch, emit completion.
   * Used by all familiars to avoid duplicating the exit path logic.
   */
  protected async handleProcessExit(
    executionId: string,
    request: WorkRequest,
    cwd: string,
    exitCode: number,
    opts?: {
      signal?: NodeJS.Signals | null;
      branch?: string;
      originalBranch?: string;
      claudeSessionId?: string;
    },
  ): Promise<void> {
    const entry = this.entries.get(executionId);
    if (entry) entry.completed = true;

    const signalInfo = opts?.signal ? ` signal=${opts.signal}` : '';
    this.emitOutput(executionId,
      `[${this.type}] Process exited: actionId=${request.actionId} exitCode=${exitCode}${signalInfo}\n`);

    let commitHash: string | undefined;
    let status: 'completed' | 'failed' = exitCode === 0 ? 'completed' : 'failed';
    try {
      const hash = await this.recordTaskResult(cwd, request, exitCode);
      commitHash = hash ?? undefined;
    } catch (err) {
      this.emitOutput(executionId,
        `[${this.type}] recordTaskResult error: ${err}\n`);
      if (exitCode === 0) status = 'failed';
    }

    if (opts?.branch) {
      await this.pushBranchToRemote(cwd, opts.branch, executionId);
    }

    if (opts?.originalBranch) {
      await this.restoreBranch(cwd, opts.originalBranch);
    }

    // When the command fails, capture the tail of the output buffer so the
    // UI error section shows what went wrong (not just "Exit code: N").
    let error: string | undefined;
    if (exitCode !== 0 && entry) {
      const allOutput = entry.outputBuffer.join('');
      const lines = allOutput.split('\n');
      const tail = lines.slice(-50).join('\n').trim();
      if (tail) {
        error = tail.length > 3000 ? tail.slice(-3000) : tail;
      }
    }

    const response: WorkResponse = {
      requestId: request.requestId,
      actionId: request.actionId,
      status,
      outputs: {
        exitCode: status === 'failed' && exitCode === 0 ? 1 : exitCode,
        commitHash,
        claudeSessionId: opts?.claudeSessionId,
        ...(error ? { error } : {}),
        ...(opts?.branch ? { summary: `branch=${opts.branch} commit=${commitHash ?? 'unknown'}` } : {}),
      },
    };
    this.emitComplete(executionId, response);
  }

  protected buildResultCommitMessage(request: WorkRequest, exitCode: number): string {
    const headline = request.inputs.description
      ? `invoker: ${request.actionId} — ${request.inputs.description}`
      : `invoker: ${request.actionId}`;
    return `${headline}\n\nExit code: ${exitCode}`;
  }

  // ── Shared Claude helpers ──────────────────────────────────

  /**
   * Build the full prompt by prepending upstream context from completed dependencies.
   */
  protected buildFullPrompt(request: WorkRequest): string {
    let fullPrompt = request.inputs.prompt ?? '';
    if (request.inputs.upstreamContext?.length) {
      const contextLines = request.inputs.upstreamContext.map(ctx => {
        let line = `[Upstream task: ${ctx.taskId}]\nDescription: ${ctx.description}\nSummary: ${ctx.summary ?? 'N/A'}`;
        if (ctx.commitHash) line += `\nCommit: ${ctx.commitHash}`;
        if (ctx.commitMessage) line += `\nCommit message:\n${ctx.commitMessage}`;
        return line;
      });
      fullPrompt = contextLines.join('\n\n') + '\n\n' + fullPrompt;
    }
    return fullPrompt;
  }

  /**
   * Build CLI args for invoking `claude` with a session ID and prompt.
   */
  protected buildClaudeArgs(sessionId: string, fullPrompt: string): string[] {
    return ['--session-id', sessionId, '--dangerously-skip-permissions', '-p', fullPrompt];
  }

  /**
   * Prepare a Claude session: generate session ID, build prompt with upstream context, build CLI args.
   * Use this instead of calling buildFullPrompt + buildClaudeArgs + randomUUID separately.
   */
  protected prepareClaudeSession(request: WorkRequest): ClaudeSessionParams {
    const sessionId = randomUUID();
    const fullPrompt = this.buildFullPrompt(request);
    const cliArgs = this.buildClaudeArgs(sessionId, fullPrompt);
    return { sessionId, cliArgs, fullPrompt };
  }

  // Abstract methods that subclasses must implement
  abstract start(request: WorkRequest): Promise<FamiliarHandle>;
  abstract kill(handle: FamiliarHandle): Promise<void>;
  abstract sendInput(handle: FamiliarHandle, input: string): void;
  abstract getTerminalSpec(handle: FamiliarHandle): TerminalSpec | null;
  abstract getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec;
  abstract destroyAll(): Promise<void>;
}
