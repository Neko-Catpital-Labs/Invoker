/**
 * Shared logic for opening an external OS terminal for a persisted task.
 */

import type { Logger } from '@invoker/contracts';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  DEFAULT_EXECUTION_AGENT,
  DockerExecutor,
  getEffectivePath,
  WorktreeExecutor,
  SshExecutor,
  type Executor,
  type ExecutorRegistry,
  type AgentRegistry,
  type PersistedTaskMeta,
  type TerminalSpec,
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
  const executionAgent = meta.executionAgent ?? DEFAULT_EXECUTION_AGENT;
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
 * Result of {@link resolveTaskTerminalSpec}.
 * Either provides the resolved {spec, cwd, meta, executor} or a refusal reason.
 */
export type ResolveTaskTerminalSpecResult =
  | {
      ok: true;
      spec: TerminalSpec;
      cwd: string;
      meta: PersistedTaskMeta;
      executor: Executor;
    }
  | { ok: false; reason: string };

export interface ResolveTaskTerminalSpecOptions {
  taskId: string;
  persistence: OpenTerminalPersistence;
  executorRegistry: ExecutorRegistry;
  executionAgentRegistry?: AgentRegistry;
  repoRoot: string;
  /** Reason to use when the task is currently running. */
  runningTaskReason?: string;
  /** When true, allow resolution even if the task status is `running` / `fixing_with_ai` — used by the embedded manager which can attach to a live executor handle. */
  allowRunning?: boolean;
  logger?: Logger;
}

/**
 * Resolve the {@link TerminalSpec} (and cwd / repaired metadata / executor) for a task
 * without launching anything. Shared between the external launcher and the embedded
 * terminal manager so workspace metadata and session-repair checks stay in one place.
 */
export function resolveTaskTerminalSpec(
  opts: ResolveTaskTerminalSpecOptions,
): ResolveTaskTerminalSpecResult {
  const { taskId, persistence, executorRegistry, repoRoot, runningTaskReason, allowRunning, logger: termLogger } = opts;

  const taskStatus = persistence.getTaskStatus(taskId);
  termLogger?.info(`taskId=${taskId} taskStatus=${taskStatus ?? 'null'}`);
  if (taskStatus == null) {
    return { ok: false, reason: `Task "${taskId}" not found.` };
  }
  if (!allowRunning && (taskStatus === 'running' || taskStatus === 'fixing_with_ai')) {
    return {
      ok: false,
      reason:
        runningTaskReason ??
        'Task is still running or being fixed with AI. View output in the embedded terminal or logs.',
    };
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

  let executor = repairedMeta.runnerKind === 'ssh' ? undefined : executorRegistry.get(repairedMeta.runnerKind);
  termLogger?.info(`executorRegistry.get("${repairedMeta.runnerKind}") → ${executor ? executor.type : 'null (will lazy-create)'}`);

  if (repairedMeta.runnerKind === 'ssh') {
    const targetId = persistence.getPoolMemberId?.(taskId)?.trim();
    const target = targetId ? loadConfig().remoteTargets?.[targetId] : undefined;
    if (!targetId) {
      return {
        ok: false,
        reason: `Cannot open terminal for SSH task "${taskId}": pool member metadata is missing.`,
      };
    }
    if (!target) {
      return {
        ok: false,
        reason: `Cannot open terminal for SSH task "${taskId}": remote target "${targetId}" is not configured.`,
      };
    }
    executor = new SshExecutor({ ...target, agentRegistry: opts.executionAgentRegistry });
  } else if (!executor) {
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
    } else {
      executor = executorRegistry.getDefault();
    }
  }

  // Managed-workspace executors (worktree, ssh, docker) MUST have a resolved workspacePath.
  // Refuse fallback to repoRoot host cwd to prevent silent data loss when workspace metadata is missing.
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
    return { ok: false, reason: errorMsg };
  }

  let spec: TerminalSpec;
  try {
    termLogger?.info(`calling executor.getRestoredTerminalSpec(meta) for task=${taskId}`);
    spec = executor.getRestoredTerminalSpec(repairedMeta);
    termLogger?.info(`getRestoredTerminalSpec returned: cwd=${spec.cwd ?? 'undefined'} command=${spec.command ?? 'undefined'} args=${JSON.stringify(spec.args ?? [])}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    termLogger?.info(`getRestoredTerminalSpec threw: ${reason}`);
    return { ok: false, reason };
  }

  if (hostWorkspaceRunnerKinds.includes(repairedMeta.runnerKind) && !spec.cwd) {
    const reason = [
      `Task "${taskId}" has no workspace path (executor=${repairedMeta.runnerKind}).`,
      `This task requires a managed workspace but workspace metadata is missing.`,
      `Recovery: Retry the task using "Recreate Task" or recreate the entire workflow.`,
      `Refusing to fall back to host repo to prevent unintended mutations.`,
    ].join(' ');
    termLogger?.info(`fail-fast: ${reason}`);
    return { ok: false, reason };
  }

  const cwd = spec.cwd ?? repoRoot;
  termLogger?.info(`effective cwd=${cwd} (repoRoot=${repoRoot})`);

  return { ok: true, spec, cwd, meta: repairedMeta, executor };
}

/**
 * Opens Terminal.app / x-terminal-emulator for the given task when it is not running.
 */
export async function openExternalTerminalForTask(
  opts: OpenExternalTerminalForTaskOptions,
): Promise<OpenTerminalResult> {
  const { repoRoot, logger: termLogger } = opts;

  const resolved = resolveTaskTerminalSpec({
    taskId: opts.taskId,
    persistence: opts.persistence,
    executorRegistry: opts.executorRegistry,
    executionAgentRegistry: opts.executionAgentRegistry,
    repoRoot: opts.repoRoot,
    runningTaskReason: opts.runningTaskReason,
    logger: opts.logger,
  });
  if (!resolved.ok) {
    return { opened: false, reason: resolved.reason };
  }
  const { spec, cwd } = resolved;
  if (resolved.meta.agentSessionId) {
    termLogger?.info(
      'building resume spec with persisted agentSessionId — ' +
        'if recreateWorkflow left a stale UUID (downstream still pending), claude --resume may report no conversation',
      { module: 'agent-session-trace' },
    );
  }

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
    if (spec.command || spec.displayBridge) {
      const osaArgs = buildMacOSOsascriptArgs(spec, cwd);
      return spawnDetachedTerminal('osascript', osaArgs, {}, onTerminalClose);
    }
    return spawnDetachedTerminal('open', ['-a', 'Terminal', cwd], {}, onTerminalClose);
  }

  return { opened: false, reason: `External terminal is not supported on platform: ${process.platform}` };
}
