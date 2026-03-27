/**
 * Conflict resolution logic, extracted from TaskExecutor.
 *
 * Each function takes a ConflictResolverHost (a subset of TaskExecutor's
 * capabilities) as its first parameter, avoiding circular imports.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import type { Orchestrator } from '@invoker/core';
import type { SQLiteAdapter } from '@invoker/persistence';
import { cleanElectronEnv } from './process-utils.js';

// ── Host interface ───────────────────────────────────────

export interface RemoteTargetConfig {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
}

/**
 * Subset of TaskExecutor that conflict resolution functions need.
 * Defined here (not by importing TaskExecutor) to avoid circular deps.
 */
export interface ConflictResolverHost {
  readonly orchestrator: Orchestrator;
  readonly persistence: SQLiteAdapter;
  readonly cwd: string;

  execGitReadonly(args: string[], cwd?: string): Promise<string>;
  execGitIn(args: string[], dir: string): Promise<string>;
  createMergeWorktree(ref: string, label: string): Promise<string>;
  removeMergeWorktree(dir: string): Promise<void>;
  spawnClaudeFix(prompt: string, cwd: string): Promise<{ stdout: string; sessionId: string }>;
  getRemoteTargetConfig?(targetId: string): RemoteTargetConfig | undefined;
}

// ── Extracted functions ──────────────────────────────────

/**
 * Resolve a merge conflict by re-creating the merge state and spawning Claude to fix it.
 * After resolution, the task is restarted so it can proceed normally.
 */
export async function resolveConflictWithClaudeImpl(
  host: ConflictResolverHost,
  taskId: string,
): Promise<void> {
  const task = host.orchestrator.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== 'failed' && task.status !== 'running') {
    throw new Error(`Task ${taskId} is not in a resolvable state (status: ${task.status})`);
  }

  const errorStr = task.execution.error;
  if (!errorStr) throw new Error(`Task ${taskId} has no error information`);

  let conflictInfo: { failedBranch: string; conflictFiles: string[] };
  try {
    const parsed = JSON.parse(errorStr);
    if (parsed?.type !== 'merge_conflict') throw new Error('not a merge conflict');
    conflictInfo = { failedBranch: parsed.failedBranch, conflictFiles: parsed.conflictFiles };
  } catch {
    throw new Error(`Task ${taskId} does not have merge conflict information`);
  }

  const taskBranch = task.execution.branch ?? `invoker/${taskId}`;
  const rawCwd = task.execution.workspacePath;
  if (!rawCwd) {
    throw new Error(`Task ${taskId} has no workspacePath — cannot resolve conflict outside a worktree`);
  }

  // SSH tasks: run conflict resolution on the remote host
  if (task.config.familiarType === 'ssh' && task.config.remoteTargetId && !existsSync(rawCwd)) {
    const target = host.getRemoteTargetConfig?.(task.config.remoteTargetId);
    if (!target) {
      throw new Error(`No remote target config for "${task.config.remoteTargetId}" — cannot resolve conflict on remote`);
    }
    await resolveConflictRemote(host, task, taskBranch, conflictInfo, rawCwd, target);
    return;
  }

  const cwd = rawCwd;
  const originalBranch = await host.execGitIn(['branch', '--show-current'], cwd);

  try {
    try {
      await host.execGitIn(['checkout', taskBranch], cwd);
    } catch {
      throw new Error(`Cannot checkout task branch ${taskBranch}`);
    }

    try {
      const depTask = host.orchestrator.getAllTasks().find(t => t.execution.branch === conflictInfo.failedBranch);
      const conflictMergeMsg = depTask?.description
        ? `Merge upstream ${conflictInfo.failedBranch} — ${depTask.description}`
        : `Merge upstream ${conflictInfo.failedBranch}`;
      await host.execGitIn(['merge', '--no-edit', '-m', conflictMergeMsg, conflictInfo.failedBranch], cwd);
      console.log(`[resolveConflict] Merge succeeded without conflict on retry for ${taskId}`);
    } catch {
      console.log(`[resolveConflict] Conflict reproduced for ${taskId}, spawning Claude to resolve...`);

      const conflictFilesList = conflictInfo.conflictFiles.join(', ');
      const prompt = [
        `The following git merge has conflicts that need to be resolved.`,
        `Conflicting files: ${conflictFilesList}`,
        ``,
        `Please resolve ALL merge conflicts in these files by:`,
        `1. Reading each conflicted file`,
        `2. Choosing the correct resolution (not just picking one side)`,
        `3. Removing all conflict markers (<<<<<<<, =======, >>>>>>>)`,
        `4. Staging the resolved files with 'git add'`,
        `5. Completing the merge with 'git commit --no-edit'`,
      ].join('\n');

      await new Promise<void>((resolve, reject) => {
        const child = spawn('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: cleanElectronEnv(),
        });
        let stderr = '';
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Claude exited with code ${code}: ${stderr.trim()}`));
        });
        child.on('error', (err) => reject(err));
      });
    }

    console.log(`[resolveConflict] Successfully resolved conflict for ${taskId}`);
  } catch (err) {
    try { await host.execGitIn(['merge', '--abort'], cwd); } catch { /* no merge in progress */ }
    try { await host.execGitIn(['checkout', originalBranch], cwd); } catch { /* best effort */ }
    throw err;
  }
}

async function resolveConflictRemote(
  host: ConflictResolverHost,
  task: ReturnType<Orchestrator['getTask']> & {},
  taskBranch: string,
  conflictInfo: { failedBranch: string; conflictFiles: string[] },
  remoteCwd: string,
  target: RemoteTargetConfig,
): Promise<void> {
  const conflictFilesList = conflictInfo.conflictFiles.join(', ');
  const prompt = [
    `The following git merge has conflicts that need to be resolved.`,
    `Conflicting files: ${conflictFilesList}`,
    ``,
    `Please resolve ALL merge conflicts in these files by:`,
    `1. Reading each conflicted file`,
    `2. Choosing the correct resolution (not just picking one side)`,
    `3. Removing all conflict markers (<<<<<<<, =======, >>>>>>>)`,
    `4. Staging the resolved files with 'git add'`,
    `5. Completing the merge with 'git commit --no-edit'`,
  ].join('\n');

  const depTask = host.orchestrator.getAllTasks().find(t => t.execution.branch === conflictInfo.failedBranch);
  const conflictMergeMsg = depTask?.description
    ? `Merge upstream ${conflictInfo.failedBranch} — ${depTask.description}`
    : `Merge upstream ${conflictInfo.failedBranch}`;

  const sessionId = randomUUID();
  const promptB64 = Buffer.from(prompt).toString('base64');
  const mergeMsgB64 = Buffer.from(conflictMergeMsg).toString('base64');

  const script = `set -euo pipefail
WT="${remoteCwd}"
if [[ "$WT" == '~' ]]; then WT="$HOME"; elif [[ "\${WT:0:2}" == '~/' ]]; then WT="$HOME/\${WT:2}"; fi
cd "$WT"
git checkout "${taskBranch}"
MERGE_MSG=$(echo "${mergeMsgB64}" | base64 -d)
if git merge --no-edit -m "$MERGE_MSG" "${conflictInfo.failedBranch}" 2>/dev/null; then
  echo "[resolveConflict] Merge succeeded without conflict on retry"
else
  echo "[resolveConflict] Conflict reproduced, spawning Claude to resolve..."
  PROMPT=$(echo "${promptB64}" | base64 -d)
  claude --session-id "${sessionId}" -p "$PROMPT" --dangerously-skip-permissions
fi
`;

  await execRemoteSsh(target, script);
  console.log(`[resolveConflict] Successfully resolved remote conflict for ${task.id}`);
}

/**
 * Build the Claude fix prompt based on task type.
 */
export function buildFixPrompt(
  task: { description: string; config: { command?: string; isMergeNode?: boolean; prompt?: string }; execution: { error?: string } },
  taskOutput: string,
): string {
  const errorLines = taskOutput.split('\n').slice(-200).join('\n');

  if (task.config.isMergeNode) {
    return [
      `A merge operation failed while consolidating task branches. Fix the underlying issue so the merge can succeed.`,
      ``,
      `Task: ${task.description}`,
      ``,
      `Error: ${task.execution.error ?? 'Unknown error'}`,
      ...(errorLines ? [``, `Output (last 200 lines):`, errorLines] : []),
      ``,
      `Diagnose and fix the root cause. Common issues include merge conflicts between task branches, ` +
      `incompatible changes across parallel tasks, or missing files. Fix the code so branches can merge cleanly.`,
    ].join('\n');
  }

  if (task.config.command) {
    return [
      `A build/test command failed. Fix the code so the command succeeds.`,
      ``,
      `Task: ${task.description}`,
      `Command: ${task.config.command}`,
      ``,
      `Error output (last 200 lines):`,
      errorLines,
      ``,
      `Fix the underlying code issue. Do NOT modify the command itself.`,
    ].join('\n');
  }

  return [
    `A task failed. Fix the underlying issue so the task can succeed.`,
    ``,
    `Task: ${task.description}`,
    ...(task.config.prompt ? [`Original prompt: ${task.config.prompt}`] : []),
    ``,
    `Error: ${task.execution.error ?? 'Unknown error'}`,
    ...(errorLines ? [``, `Output (last 200 lines):`, errorLines] : []),
    ``,
    `Fix the underlying code issue that caused this task to fail.`,
  ].join('\n');
}

/**
 * Fix a failed command task by spawning Claude with the error output.
 * For SSH tasks, Claude runs on the remote host in the remote worktree.
 */
export async function fixWithClaudeImpl(
  host: ConflictResolverHost,
  taskId: string,
  taskOutput: string,
): Promise<void> {
  const task = host.orchestrator.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== 'failed' && task.status !== 'running') {
    throw new Error(`Task ${taskId} is not in a fixable state (status: ${task.status})`);
  }

  const prompt = buildFixPrompt(task, taskOutput);
  const workspacePath = task.execution.workspacePath;

  // SSH tasks: run Claude on the remote host
  if (task.config.familiarType === 'ssh' && task.config.remoteTargetId && workspacePath && !existsSync(workspacePath)) {
    const target = host.getRemoteTargetConfig?.(task.config.remoteTargetId);
    if (!target) {
      throw new Error(`No remote target config for "${task.config.remoteTargetId}" — cannot fix on remote`);
    }
    const { stdout: output, sessionId } = await spawnRemoteClaudeFixImpl(prompt, workspacePath, target);
    if (output) {
      host.persistence.appendTaskOutput(taskId, `\n[Fix with Claude (remote)] Output:\n${output}`);
    }
    host.persistence.updateTask(taskId, { execution: { claudeSessionId: sessionId } });
    console.log(`[fixWithClaude] Successfully applied remote fix for ${taskId} (session=${sessionId})`);
    return;
  }

  const cwd = (workspacePath && existsSync(workspacePath)) ? workspacePath : host.cwd;

  const { stdout: output, sessionId } = await host.spawnClaudeFix(prompt, cwd);
  if (output) {
    host.persistence.appendTaskOutput(taskId, `\n[Fix with Claude] Output:\n${output}`);
  }
  host.persistence.updateTask(taskId, { execution: { claudeSessionId: sessionId } });
  console.log(`[fixWithClaude] Successfully applied fix for ${taskId} (session=${sessionId})`);
}

/**
 * Spawn Claude subprocess for local fixes.
 */
export function spawnClaudeFixImpl(
  prompt: string,
  cwd: string,
): Promise<{ stdout: string; sessionId: string }> {
  const cmd = process.env.INVOKER_CLAUDE_FIX_COMMAND ?? 'claude';
  const sessionId = randomUUID();
  return new Promise<{ stdout: string; sessionId: string }>((resolve, reject) => {
    const child = spawn(cmd, ['--session-id', sessionId, '-p', prompt, '--dangerously-skip-permissions'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanElectronEnv(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, sessionId });
      else reject(new Error(`Claude exited with code ${code}: ${stderr.trim()}`));
    });
    child.on('error', (err) => reject(err));
  });
}

/**
 * Spawn Claude on a remote SSH host for fixing SSH-executed tasks.
 */
export function spawnRemoteClaudeFixImpl(
  prompt: string,
  remoteCwd: string,
  target: RemoteTargetConfig,
): Promise<{ stdout: string; sessionId: string }> {
  const sessionId = randomUUID();
  const promptB64 = Buffer.from(prompt).toString('base64');

  const script = `set -euo pipefail
WT="${remoteCwd}"
if [[ "$WT" == '~' ]]; then WT="$HOME"; elif [[ "\${WT:0:2}" == '~/' ]]; then WT="$HOME/\${WT:2}"; fi
cd "$WT"
PROMPT=$(echo "${promptB64}" | base64 -d)
claude --session-id "${sessionId}" -p "$PROMPT" --dangerously-skip-permissions
`;

  const sshArgs = [
    '-i', target.sshKeyPath,
    '-p', String(target.port ?? 22),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    `${target.user}@${target.host}`,
    'bash', '-s',
  ];

  return new Promise<{ stdout: string; sessionId: string }>((resolve, reject) => {
    const child = spawn('ssh', sshArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanElectronEnv(),
    });
    child.stdin?.write(script);
    child.stdin?.end();

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, sessionId });
      else reject(new Error(`Remote Claude fix failed (exit ${code}): ${stderr.trim()}`));
    });
    child.on('error', (err) => reject(err));
  });
}

/**
 * Execute a bash script on a remote host via SSH. Throws on non-zero exit.
 */
function execRemoteSsh(target: RemoteTargetConfig, script: string): Promise<string> {
  const sshArgs = [
    '-i', target.sshKeyPath,
    '-p', String(target.port ?? 22),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    `${target.user}@${target.host}`,
    'bash', '-s',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanElectronEnv(),
    });
    child.stdin?.write(script);
    child.stdin?.end();

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`SSH remote script failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
    child.on('error', (err) => reject(err));
  });
}
