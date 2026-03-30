/**
 * Shared logic for opening an external OS terminal for a persisted task (GUI IPC + headless CLI).
 */

import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  DockerFamiliar,
  WorktreeFamiliar,
  SshFamiliar,
  type FamiliarRegistry,
  type PersistedTaskMeta,
} from '@invoker/executors';
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
  getFamiliarType(taskId: string): string | null;
  getAgentSessionId(taskId: string): string | null;
  getContainerId(taskId: string): string | null;
  getWorkspacePath(taskId: string): string | null;
  getBranch(taskId: string): string | null;
  getRemoteTargetId?(taskId: string): string | null;
}

export interface OpenExternalTerminalForTaskOptions {
  taskId: string;
  persistence: OpenTerminalPersistence;
  familiarRegistry: FamiliarRegistry;
  repoRoot: string;
  /** Shown when task status is `running` (GUI vs headless wording). */
  runningTaskReason?: string;
}

/**
 * Opens Terminal.app / x-terminal-emulator for the given task when it is not running.
 */
export async function openExternalTerminalForTask(
  opts: OpenExternalTerminalForTaskOptions,
): Promise<OpenTerminalResult> {
  const { taskId, persistence, familiarRegistry, repoRoot, runningTaskReason } = opts;

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
    familiarType: persistence.getFamiliarType(taskId) ?? 'worktree',
    agentSessionId: persistence.getAgentSessionId(taskId) ?? undefined,
    containerId: persistence.getContainerId(taskId) ?? undefined,
    workspacePath: persistence.getWorkspacePath(taskId) ?? undefined,
    branch: persistence.getBranch(taskId) ?? undefined,
  };
  console.log(`[open-terminal] meta from DB: familiarType=${meta.familiarType} workspacePath=${meta.workspacePath ?? 'undefined'} branch=${meta.branch ?? 'undefined'} agentSessionId=${meta.agentSessionId ?? 'undefined'} containerId=${meta.containerId ?? 'undefined'}`);
  if (meta.agentSessionId) {
    console.log(
      '[agent-session-trace] open-terminal: building resume spec with persisted agentSessionId — ' +
        'if restartWorkflow left a stale UUID (downstream still pending), claude --resume may report no conversation',
    );
  }

  let familiar = familiarRegistry.get(meta.familiarType);
  console.log(`[open-terminal] familiarRegistry.get("${meta.familiarType}") → ${familiar ? familiar.type : 'null (will lazy-create)'}`);

  if (!familiar) {
    if (meta.familiarType === 'docker') {
      const docker = new DockerFamiliar({ workspaceDir: repoRoot });
      familiarRegistry.register('docker', docker);
      familiar = docker;
    } else if (meta.familiarType === 'worktree') {
      const invokerHome = path.resolve(homedir(), '.invoker');
      const worktree = new WorktreeFamiliar({
        worktreeBaseDir: path.resolve(invokerHome, 'worktrees'),
        cacheDir: path.resolve(invokerHome, 'repos'),
        maxWorktrees: 5,
      });
      familiarRegistry.register('worktree', worktree);
      familiar = worktree;
    } else if (meta.familiarType === 'ssh') {
      const targetId = persistence.getRemoteTargetId?.(taskId);
      const target = targetId ? loadConfig().remoteTargets?.[targetId] : undefined;
      familiar = target ? new SshFamiliar(target) : familiarRegistry.getDefault();
    } else {
      familiar = familiarRegistry.getDefault();
    }
  }

  let spec: { cwd?: string; command?: string; args?: string[] };
  try {
    console.log(`[open-terminal] calling familiar.getRestoredTerminalSpec(meta) for task=${taskId}`);
    spec = familiar.getRestoredTerminalSpec(meta);
    console.log(`[open-terminal] getRestoredTerminalSpec returned: cwd=${spec.cwd ?? 'undefined'} command=${spec.command ?? 'undefined'} args=${JSON.stringify(spec.args ?? [])}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`[open-terminal] getRestoredTerminalSpec threw: ${reason}`);
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
