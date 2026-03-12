import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { Familiar, FamiliarHandle, PersistedTaskMeta, TerminalSpec, Unsubscribe } from './familiar.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

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
}

export interface ClaudeSessionParams {
  sessionId: string;
  cliArgs: string[];
  fullPrompt: string;
}

export abstract class BaseFamiliar<TEntry extends BaseEntry> implements Familiar {
  abstract readonly type: string;
  protected entries = new Map<string, TEntry>();
  protected heartbeatIntervalMs: number;

  constructor(heartbeatIntervalMs?: number) {
    this.heartbeatIntervalMs = heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
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
      } else {
        this.emitHeartbeat(executionId);
      }
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
    actionId: string,
    meta?: {
      description?: string;
      prompt?: string;
      upstreamContext?: Array<{taskId: string; description: string; summary?: string}>;
    },
  ): Promise<string | null> {
    try {
      // Check if it's a git repo
      await this.execGitSimple(['rev-parse', '--is-inside-work-tree'], cwd);

      // Stage all changes
      await this.execGitSimple(['add', '-A'], cwd);

      // Check if there are staged changes
      try {
        await this.execGitSimple(['diff', '--cached', '--quiet'], cwd);
        return null; // No changes
      } catch {
        // There are staged changes — commit
      }

      const message = this.buildCommitMessage(actionId, meta);
      await this.execGitSimple(['commit', '-m', message], cwd);
      const hash = await this.execGitSimple(['rev-parse', 'HEAD'], cwd);
      return hash.trim();
    } catch {
      return null; // Not a git repo or git error
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

  private buildCommitMessage(
    actionId: string,
    meta?: {
      description?: string;
      prompt?: string;
      upstreamContext?: Array<{taskId: string; description: string; summary?: string; commitMessage?: string}>;
    },
  ): string {
    const headline = meta?.description
      ? `invoker: ${actionId} — ${meta.description}`
      : `invoker: ${actionId}`;

    const parts = [headline];

    if (meta?.prompt) {
      parts.push(`\n## Prompt\n${meta.prompt}`);
    }

    if (meta?.upstreamContext?.length) {
      const entries = meta.upstreamContext.map(ctx => {
        // Prefer first line of commit message over raw summary (which is often "branch=... commit=...")
        const detail = ctx.commitMessage?.split('\n')[0] ?? ctx.summary;
        return `- ${ctx.taskId}: ${ctx.description}${detail ? ` → ${detail}` : ''}`;
      });
      parts.push(`\n## Upstream Context\n${entries.join('\n')}`);
    }

    return parts.join('\n');
  }

  private execGitSimple(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`git ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
      });
    });
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
