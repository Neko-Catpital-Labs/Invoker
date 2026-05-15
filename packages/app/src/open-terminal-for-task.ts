/**
 * Shared logic for opening an external OS terminal for a persisted task.
 */

import type { Logger } from '@invoker/contracts';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  DockerExecutor,
  getEffectivePath,
  WorktreeExecutor,
  SshExecutor,
  type ExecutorRegistry,
  type AgentRegistry,
  type PersistedTaskMeta,
} from '@invoker/execution-engine';
import { loadConfig } from './config.js';
import {
  buildLinuxXTerminalBashScript,
  buildMacOSOsascriptArgs,
  spawnDetachedTerminal,
  type OpenTerminalResult,
} from './terminal-external-launch.js';
import { resolveEffectiveMaxConcurrency } from './execution-capacity.js';

/** Persistence methods required to resolve terminal cwd / command for a task. */
export interface OpenTerminalPersistence {
  getTaskStatus(taskId: string): string | null;
  getRunnerKind(taskId: string): string | null;
  getAgentSessionId(taskId: string): string | null;
  getLastAgentSessionId?(taskId: string): string | null;
  getExecutionAgent?(taskId: string): string | null;
  getContainerId(taskId: string): string | null;
  getWorkspacePath(taskId: string): string | null;
  getBranch(taskId: string): string | null;
  getPoolMemberId?(taskId: string): string | null;
  loadAttempts?(taskId: string): Array<{ id: string; agentSessionId?: string }>;
  updateTask?(taskId: string, changes: { execution?: { agentSessionId?: string; lastAgentSessionId?: string } }): void;
  updateAttempt?(attemptId: string, changes: { agentSessionId?: string }): void;
}

export interface OpenExternalTerminalForTaskOptions {
  taskId: string;
  persistence: OpenTerminalPersistence;
  executorRegistry: ExecutorRegistry;
  executionAgentRegistry?: AgentRegistry;
  repoRoot: string;
  /** Shown when task status is `running`. */
  runningTaskReason?: string;
  logger?: Logger;
}

/**
 * Codex session repair for open-terminal:
 * - validates the persisted sessionId via SessionDriver.loadSession()
 * - recovers from attempt history / lastAgentSessionId when possible
 * - clears sessionId (cwd-only fallback) when unrecoverable
 */
export function repairCodexResumeSessionMeta(
  meta: PersistedTaskMeta,
  persistence: OpenTerminalPersistence,
  executionAgentRegistry?: AgentRegistry,
): PersistedTaskMeta {
  const executionAgent = meta.executionAgent ?? 'claude';
  const originalSessionId = meta.agentSessionId;
  if (executionAgent !== 'codex' || !originalSessionId) return meta;

  const driver = executionAgentRegistry?.getSessionDriver('codex');
  if (!driver) return meta;

  const hasSavedSession = (sid: string): boolean => {
    try {
      return !!driver.loadSession(sid);
    } catch {
      return false;
    }
  };

  if (hasSavedSession(originalSessionId)) return meta;

  const attemptsNewestFirst = [...(persistence.loadAttempts?.(meta.taskId) ?? [])].reverse();
  const seen = new Set<string>([originalSessionId]);
  const candidates: string[] = [];

  for (const a of attemptsNewestFirst) {
    const sid = a.agentSessionId;
    if (sid && !seen.has(sid)) {
      seen.add(sid);
      candidates.push(sid);
    }
  }

  const lastAgentSid = persistence.getLastAgentSessionId?.(meta.taskId);
  if (lastAgentSid && !seen.has(lastAgentSid)) {
    seen.add(lastAgentSid);
    candidates.push(lastAgentSid);
  }

  let recoveredSessionId: string | undefined;
  for (const sid of candidates) {
    if (hasSavedSession(sid)) {
      recoveredSessionId = sid;
      break;
    }
  }

  if (!recoveredSessionId) {
    // codex session repair: stale sessionId, opening cwd shell without resume
    return { ...meta, agentSessionId: undefined };
  }

  // codex session repair: repaired stale sessionId
  persistence.updateTask?.(meta.taskId, {
    execution: { agentSessionId: recoveredSessionId, lastAgentSessionId: recoveredSessionId },
  });

  const currentAttempt = attemptsNewestFirst[0];
  if (
    currentAttempt?.id &&
    (!currentAttempt.agentSessionId || currentAttempt.agentSessionId === originalSessionId)
  ) {
    persistence.updateAttempt?.(currentAttempt.id, { agentSessionId: recoveredSessionId });
  }

  return { ...meta, agentSessionId: recoveredSessionId };
}

/**
 * Outcome of resolving the persisted terminal spec for a task.
 *
 * Shared by `openExternalTerminalForTask` and the embedded terminal
 * session manager so both paths apply identical safety checks
 * (workspace metadata invariants, codex session repair, lazy executor
 * registration). Callers decide what to do with the `status` value —
 * the external launcher refuses to attach to a running task while the
 * embedded manager attaches via the active executor handle.
 */
export type TerminalSpecResolution =
  | {
      ok: true;
      meta: PersistedTaskMeta;
      executor: import('@invoker/execution-engine').Executor;
      spec: { cwd?: string; command?: string; args?: string[]; linuxTerminalTail?: 'exec_bash' | 'pause' };
      cwd: string;
      status: string;
    }
  | {
      ok: false;
      reason: string;
      status?: string;
    };

export interface ResolveTerminalSpecOptions {
  taskId: string;
  persistence: OpenTerminalPersistence;
  executorRegistry: ExecutorRegistry;
  executionAgentRegistry?: AgentRegistry;
  repoRoot: string;
  logger?: Logger;
}

/**
 * Build the persisted-meta backed TerminalSpec for a task and resolve
 * the executor that owns it. Enforces:
 *   - task exists
 *   - codex session repair (`repairCodexResumeSessionMeta`)
 *   - managed-workspace invariants (worktree/ssh/docker require workspacePath)
 *   - host workspace invariant (worktree spec must yield cwd)
 *
 * Does NOT short-circuit on running status — callers handle that.
 */
export function resolveTerminalSpecForTask(
  opts: ResolveTerminalSpecOptions,
): TerminalSpecResolution {
  const { taskId, persistence, executorRegistry, repoRoot, logger: termLogger } = opts;

  const taskStatus = persistence.getTaskStatus(taskId);
  termLogger?.info(`taskId=${taskId} taskStatus=${taskStatus ?? 'null'}`);
  if (taskStatus == null) {
    return { ok: false, reason: `Task "${taskId}" not found.` };
  }

  const meta: PersistedTaskMeta = {
    taskId,
    runnerKind: persistence.getRunnerKind(taskId) ?? 'worktree',
    agentSessionId: persistence.getAgentSessionId(taskId) ?? undefined,
    executionAgent: persistence.getExecutionAgent?.(taskId) ?? undefined,
    containerId: persistence.getContainerId(taskId) ?? undefined,
    workspacePath: persistence.getWorkspacePath(taskId) ?? undefined,
    branch: persistence.getBranch(taskId) ?? undefined,
  };
  const repairedMeta = repairCodexResumeSessionMeta(meta, persistence, opts.executionAgentRegistry);
  termLogger?.info(
    `meta from DB: runnerKind=${repairedMeta.runnerKind} workspacePath=${repairedMeta.workspacePath ?? 'undefined'} branch=${repairedMeta.branch ?? 'undefined'} agentSessionId=${repairedMeta.agentSessionId ?? 'undefined'} executionAgent=${repairedMeta.executionAgent ?? 'undefined'} containerId=${repairedMeta.containerId ?? 'undefined'}`,
  );
  if (repairedMeta.agentSessionId) {
    termLogger?.info(
      'building resume spec with persisted agentSessionId — ' +
        'if recreateWorkflow left a stale UUID (downstream still pending), claude --resume may report no conversation',
      { module: 'agent-session-trace' },
    );
  }

  let executor = executorRegistry.get(repairedMeta.runnerKind);
  termLogger?.info(`executorRegistry.get("${repairedMeta.runnerKind}") → ${executor ? executor.type : 'null (will lazy-create)'}`);

  if (!executor) {
    if (repairedMeta.runnerKind === 'docker') {
      const docker = new DockerExecutor({
        agentRegistry: opts.executionAgentRegistry,
      });
      executorRegistry.register('docker', docker);
      executor = docker;
    } else if (repairedMeta.runnerKind === 'worktree') {
      const invokerHome = path.resolve(homedir(), '.invoker');
      const maxWorktrees = resolveEffectiveMaxConcurrency(loadConfig().maxConcurrency);
      const worktree = new WorktreeExecutor({
        worktreeBaseDir: path.resolve(invokerHome, 'worktrees'),
        cacheDir: path.resolve(invokerHome, 'repos'),
        maxWorktrees,
        agentRegistry: opts.executionAgentRegistry,
      });
      executorRegistry.register('worktree', worktree);
      executor = worktree;
    } else if (repairedMeta.runnerKind === 'ssh') {
      const targetId = persistence.getPoolMemberId?.(taskId);
      const target = targetId ? loadConfig().remoteTargets?.[targetId] : undefined;
      executor = target
        ? new SshExecutor({ ...target, agentRegistry: opts.executionAgentRegistry })
        : executorRegistry.getDefault();
    } else {
      executor = executorRegistry.getDefault();
    }
  }

  // Managed-workspace executors (worktree, ssh, docker) MUST have a resolved workspacePath.
  // Refuse fallback to repoRoot host cwd to prevent silent data loss when workspace metadata is missing.
  // SSH is excluded from hostWorkspaceRunnerKinds because its workspace is remote — its
  // getRestoredTerminalSpec returns { command, args } without a local cwd by design. The first
  // workspace-metadata check below already enforces that SSH tasks have repairedMeta.workspacePath.
  const managedRunnerKinds = ['worktree', 'ssh', 'docker'];
  const hostWorkspaceRunnerKinds = ['worktree'];
  const isManagedExecutor = managedRunnerKinds.includes(repairedMeta.runnerKind);
  if (isManagedExecutor && !repairedMeta.workspacePath) {
    const errorMsg = [
      `Cannot open terminal for task "${taskId}": workspace metadata is missing.`,
      `Executor type "${repairedMeta.runnerKind}" requires a managed workspace but workspacePath is not set.`,
      `This typically means the task failed during startup before workspace metadata was persisted.`,
      ``,
      `Recovery options:`,
      `  1. Recreate the task (may require recreating the workflow if cross-workflow dependencies exist)`,
      `  2. Check task logs to diagnose the startup failure`,
      ``,
      `Refusing to fall back to host repo to prevent accidental mutation of the main repository.`,
    ].join('\n');
    termLogger?.info(`managed workspace invariant violation: ${errorMsg}`);
    return { ok: false, reason: errorMsg, status: taskStatus };
  }

  let spec: { cwd?: string; command?: string; args?: string[]; linuxTerminalTail?: 'exec_bash' | 'pause' };
  try {
    termLogger?.info(`calling executor.getRestoredTerminalSpec(meta) for task=${taskId}`);
    spec = executor.getRestoredTerminalSpec(repairedMeta);
    termLogger?.info(`getRestoredTerminalSpec returned: cwd=${spec.cwd ?? 'undefined'} command=${spec.command ?? 'undefined'} args=${JSON.stringify(spec.args ?? [])}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    termLogger?.info(`getRestoredTerminalSpec threw: ${reason}`);
    return { ok: false, reason, status: taskStatus };
  }

  // Fail-fast workspace invariant: managed executors must have resolved workspace path
  if (hostWorkspaceRunnerKinds.includes(repairedMeta.runnerKind) && !spec.cwd) {
    const reason = [
      `Task "${taskId}" has no workspace path (executor=${repairedMeta.runnerKind}).`,
      `This task requires a managed workspace but workspace metadata is missing.`,
      `Recovery: Retry the task using "Recreate Task" or recreate the entire workflow.`,
      `Refusing to fall back to host repo to prevent unintended mutations.`,
    ].join(' ');
    termLogger?.info(`fail-fast: ${reason}`);
    return { ok: false, reason, status: taskStatus };
  }

  const cwd = spec.cwd ?? repoRoot;
  termLogger?.info(`effective cwd=${cwd} (repoRoot=${repoRoot})`);

  return { ok: true, meta: repairedMeta, executor, spec, cwd, status: taskStatus };
}

/**
 * Opens Terminal.app / x-terminal-emulator for the given task when it is not running.
 */
export async function openExternalTerminalForTask(
  opts: OpenExternalTerminalForTaskOptions,
): Promise<OpenTerminalResult> {
  const { taskId, repoRoot, runningTaskReason, logger: termLogger } = opts;

  // Pre-check running status: external launcher refuses to attach to a live task.
  // Done before workspace invariants so the user sees the running message rather
  // than a less-useful workspace-metadata error when both apply.
  const preStatus = opts.persistence.getTaskStatus(taskId);
  termLogger?.info(`taskId=${taskId} taskStatus=${preStatus ?? 'null'}`);
  if (preStatus == null) {
    return { opened: false, reason: `Task "${taskId}" not found.` };
  }
  if (preStatus === 'running' || preStatus === 'fixing_with_ai') {
    return {
      opened: false,
      reason:
        runningTaskReason ??
        'Task is still running or being fixed with AI. View output in the embedded terminal or logs.',
    };
  }

  const resolution = resolveTerminalSpecForTask({
    taskId,
    persistence: opts.persistence,
    executorRegistry: opts.executorRegistry,
    executionAgentRegistry: opts.executionAgentRegistry,
    repoRoot,
    logger: termLogger,
  });
  if (!resolution.ok) {
    return { opened: false, reason: resolution.reason };
  }
  const { spec, cwd } = resolution;

  const onTerminalClose = () => {
    if (!cwd || cwd === repoRoot) return;
    try {
      execSync('git diff HEAD --quiet', { cwd, stdio: 'ignore' });
    } catch {
      /* dirty */
    }
  };

  if (process.platform === 'linux') {
    const cleanEnv: Record<string, string> = {};
    const keep = [
      'HOME', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY',
      'SHELL', 'USER', 'TERM', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'LANG',
      'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY',
    ];
    for (const k of keep) {
      if (process.env[k]) cleanEnv[k] = process.env[k]!;
    }
    cleanEnv.PATH = getEffectivePath();
    if (!cleanEnv.TERM) cleanEnv.TERM = 'xterm-256color';

    const bashScript = buildLinuxXTerminalBashScript(spec, cwd);
    const termArgs = ['-e', 'bash', '-c', bashScript];
    return spawnDetachedTerminal('x-terminal-emulator', termArgs, { env: cleanEnv }, onTerminalClose);
  }

  if (process.platform === 'darwin') {
    if (spec.command) {
      const osaArgs = buildMacOSOsascriptArgs(spec, cwd);
      return spawnDetachedTerminal('osascript', osaArgs, {}, onTerminalClose);
    }
    return spawnDetachedTerminal('open', ['-a', 'Terminal', cwd], {}, onTerminalClose);
  }

  return { opened: false, reason: `External terminal is not supported on platform: ${process.platform}` };
}
