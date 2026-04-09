/**
 * Shared logic for opening an external OS terminal for a persisted task (GUI IPC + headless CLI).
 */

import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  DockerExecutor,
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

/** Persistence methods required to resolve terminal cwd / command for a task. */
export interface OpenTerminalPersistence {
  getTaskStatus(taskId: string): string | null;
  getExecutorType(taskId: string): string | null;
  getAgentSessionId(taskId: string): string | null;
  getLastAgentSessionId?(taskId: string): string | null;
  getExecutionAgent?(taskId: string): string | null;
  getContainerId(taskId: string): string | null;
  getWorkspacePath(taskId: string): string | null;
  getBranch(taskId: string): string | null;
  getRemoteTargetId?(taskId: string): string | null;
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
  /** Shown when task status is `running` (GUI vs headless wording). */
  runningTaskReason?: string;
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
    console.warn(
      `[open-terminal][codex-session-repair] task="${meta.taskId}" stale sessionId="${originalSessionId}" has no saved Codex session; opening cwd shell without resume`,
    );
    return { ...meta, agentSessionId: undefined };
  }

  console.log(
    `[open-terminal][codex-session-repair] task="${meta.taskId}" repaired stale codex sessionId old="${originalSessionId}" new="${recoveredSessionId}"`,
  );
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
 * Opens Terminal.app / x-terminal-emulator for the given task when it is not running.
 */
export async function openExternalTerminalForTask(
  opts: OpenExternalTerminalForTaskOptions,
): Promise<OpenTerminalResult> {
  const { taskId, persistence, executorRegistry, repoRoot, runningTaskReason } = opts;

  const taskStatus = persistence.getTaskStatus(taskId);
  console.log(`[open-terminal] taskId=${taskId} taskStatus=${taskStatus ?? 'null'}`);
  if (taskStatus == null) {
    return { opened: false, reason: `Task "${taskId}" not found.` };
  }
  if (taskStatus === 'running' || taskStatus === 'fixing_with_ai') {
    return {
      opened: false,
      reason:
        runningTaskReason ??
        'Task is still running or being fixed with AI. View output in the embedded terminal or logs.',
    };
  }

  const meta: PersistedTaskMeta = {
    taskId,
    executorType: persistence.getExecutorType(taskId) ?? 'worktree',
    agentSessionId: persistence.getAgentSessionId(taskId) ?? undefined,
    executionAgent: persistence.getExecutionAgent?.(taskId) ?? undefined,
    containerId: persistence.getContainerId(taskId) ?? undefined,
    workspacePath: persistence.getWorkspacePath(taskId) ?? undefined,
    branch: persistence.getBranch(taskId) ?? undefined,
  };
  const repairedMeta = repairCodexResumeSessionMeta(meta, persistence, opts.executionAgentRegistry);
  console.log(
    `[open-terminal] meta from DB: executorType=${repairedMeta.executorType} workspacePath=${repairedMeta.workspacePath ?? 'undefined'} branch=${repairedMeta.branch ?? 'undefined'} agentSessionId=${repairedMeta.agentSessionId ?? 'undefined'} executionAgent=${repairedMeta.executionAgent ?? 'undefined'} containerId=${repairedMeta.containerId ?? 'undefined'}`,
  );
  if (repairedMeta.agentSessionId) {
    console.log(
      '[agent-session-trace] open-terminal: building resume spec with persisted agentSessionId — ' +
        'if recreateWorkflow left a stale UUID (downstream still pending), claude --resume may report no conversation',
    );
  }

  let familiar = executorRegistry.get(repairedMeta.executorType);
  console.log(`[open-terminal] executorRegistry.get("${repairedMeta.executorType}") → ${familiar ? familiar.type : 'null (will lazy-create)'}`);

  if (!familiar) {
    if (repairedMeta.executorType === 'docker') {
      const docker = new DockerExecutor({
        agentRegistry: opts.executionAgentRegistry,
      });
      executorRegistry.register('docker', docker);
      familiar = docker;
    } else if (repairedMeta.executorType === 'worktree') {
      const invokerHome = path.resolve(homedir(), '.invoker');
      const worktree = new WorktreeExecutor({
        worktreeBaseDir: path.resolve(invokerHome, 'worktrees'),
        cacheDir: path.resolve(invokerHome, 'repos'),
        maxWorktrees: 5,
        agentRegistry: opts.executionAgentRegistry,
      });
      executorRegistry.register('worktree', worktree);
      familiar = worktree;
    } else if (repairedMeta.executorType === 'ssh') {
      const targetId = persistence.getRemoteTargetId?.(taskId);
      const target = targetId ? loadConfig().remoteTargets?.[targetId] : undefined;
      familiar = target
        ? new SshExecutor({ ...target, agentRegistry: opts.executionAgentRegistry })
        : executorRegistry.getDefault();
    } else {
      familiar = executorRegistry.getDefault();
    }
  }

  // Managed-workspace familiars (worktree, ssh, docker) MUST have a resolved workspacePath.
  // Refuse fallback to repoRoot host cwd to prevent silent data loss when workspace metadata is missing.
  // SSH is excluded from hostWorkspaceFamiliarTypes because its workspace is remote — its
  // getRestoredTerminalSpec returns { command, args } without a local cwd by design. The first
  // workspace-metadata check below already enforces that SSH tasks have repairedMeta.workspacePath.
  const managedFamiliarTypes = ['worktree', 'ssh', 'docker'];
  const hostWorkspaceFamiliarTypes = ['worktree'];
  const isManagedFamiliar = managedFamiliarTypes.includes(repairedMeta.executorType);
  if (isManagedFamiliar && !repairedMeta.workspacePath) {
    const errorMsg = [
      `Cannot open terminal for task "${taskId}": workspace metadata is missing.`,
      `Executor type "${repairedMeta.executorType}" requires a managed workspace but workspacePath is not set.`,
      `This typically means the task failed during startup before workspace metadata was persisted.`,
      ``,
      `Recovery options:`,
      `  1. Recreate the task (may require recreating the workflow if cross-workflow dependencies exist)`,
      `  2. Check task logs to diagnose the startup failure`,
      ``,
      `Refusing to fall back to host repo to prevent accidental mutation of the main repository.`,
    ].join('\n');
    console.log(`[open-terminal] managed workspace invariant violation: ${errorMsg}`);
    return { opened: false, reason: errorMsg };
  }

  let spec: { cwd?: string; command?: string; args?: string[] };
  try {
    console.log(`[open-terminal] calling familiar.getRestoredTerminalSpec(meta) for task=${taskId}`);
    spec = familiar.getRestoredTerminalSpec(repairedMeta);
    console.log(`[open-terminal] getRestoredTerminalSpec returned: cwd=${spec.cwd ?? 'undefined'} command=${spec.command ?? 'undefined'} args=${JSON.stringify(spec.args ?? [])}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`[open-terminal] getRestoredTerminalSpec threw: ${reason}`);
    return { opened: false, reason };
  }

  // Fail-fast workspace invariant: managed familiars must have resolved workspace path
  if (hostWorkspaceFamiliarTypes.includes(repairedMeta.executorType) && !spec.cwd) {
    const reason = [
      `Task "${taskId}" has no workspace path (familiar=${repairedMeta.executorType}).`,
      `This task requires a managed workspace but workspace metadata is missing.`,
      `Recovery: Retry the task using "Recreate Task" or recreate the entire workflow.`,
      `Refusing to fall back to host repo to prevent unintended mutations.`,
    ].join(' ');
    console.log(`[open-terminal] fail-fast: ${reason}`);
    return { opened: false, reason };
  }

  const cwd = spec.cwd ?? repoRoot;
  console.log(`[open-terminal] effective cwd=${cwd} (repoRoot=${repoRoot})`);

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
    cleanEnv.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
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
