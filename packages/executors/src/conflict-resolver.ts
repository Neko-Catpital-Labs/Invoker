/**
 * Conflict resolution logic, extracted from TaskExecutor.
 *
 * Each function takes a ConflictResolverHost (a subset of TaskExecutor's
 * capabilities) as its first parameter, avoiding circular imports.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Orchestrator } from '@invoker/core';
import type { SQLiteAdapter } from '@invoker/persistence';
import { cleanElectronEnv } from './process-utils.js';
import type { ExecutionAgent } from './agent.js';
import type { SessionDriver } from './session-driver.js';
import type { AgentRegistry } from './agent-registry.js';

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
  readonly agentRegistry?: AgentRegistry;

  execGitReadonly(args: string[], cwd?: string): Promise<string>;
  execGitIn(args: string[], dir: string): Promise<string>;
  createMergeWorktree(ref: string, label: string, repoUrl?: string): Promise<string>;
  removeMergeWorktree(dir: string): Promise<void>;
  spawnAgentFix(prompt: string, cwd: string, agentName?: string): Promise<{ stdout: string; sessionId: string }>;
  getRemoteTargetConfig?(targetId: string): RemoteTargetConfig | undefined;
}

const DEFAULT_MAX_INLINE_PROMPT_BYTES = 64 * 1024;
const MAX_INLINE_PROMPT_BYTES = (() => {
  const raw = process.env.INVOKER_MAX_INLINE_AGENT_PROMPT_BYTES;
  if (!raw) return DEFAULT_MAX_INLINE_PROMPT_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_INLINE_PROMPT_BYTES;
})();

function promptByteLength(prompt: string): number {
  return Buffer.byteLength(prompt, 'utf8');
}

function buildPromptFileBootstrap(promptPath: string): string {
  return [
    `The full task instructions are in this file: ${promptPath}`,
    `Read the file completely, then execute those instructions in this workspace.`,
    `Do not ask for the file contents.`,
  ].join('\n');
}

function materializeLocalPrompt(prompt: string): { effectivePrompt: string; cleanup: () => void } {
  if (promptByteLength(prompt) <= MAX_INLINE_PROMPT_BYTES) {
    return { effectivePrompt: prompt, cleanup: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), 'invoker-agent-prompt-'));
  const promptPath = join(dir, 'prompt.md');
  writeFileSync(promptPath, prompt, 'utf8');
  return {
    effectivePrompt: buildPromptFileBootstrap(promptPath),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

function materializeRemotePrompt(prompt: string): { effectivePrompt: string; remotePromptFilePath?: string; promptB64?: string } {
  if (promptByteLength(prompt) <= MAX_INLINE_PROMPT_BYTES) {
    return { effectivePrompt: prompt };
  }
  const remotePromptFilePath = `/tmp/invoker-agent-prompt-${randomUUID()}.md`;
  return {
    effectivePrompt: buildPromptFileBootstrap(remotePromptFilePath),
    remotePromptFilePath,
    promptB64: Buffer.from(prompt, 'utf8').toString('base64'),
  };
}

// ── Extracted functions ──────────────────────────────────

/**
 * Resolve a merge conflict by re-creating the merge state and spawning an agent to fix it.
 * After resolution, the task is restarted so it can proceed normally.
 */
export async function resolveConflictImpl(
  host: ConflictResolverHost,
  taskId: string,
  savedError?: string,
  agentName?: string,
): Promise<void> {
  const task = host.orchestrator.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== 'failed' && task.status !== 'running' && task.status !== 'fixing_with_ai') {
    throw new Error(`Task ${taskId} is not in a resolvable state (status: ${task.status})`);
  }

  const errorStr = savedError ?? task.execution.error;
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
    throw new Error(
      `resolveConflict: task "${taskId}" has no workspacePath. ` +
      `All tasks must have a managed workspace; refusing to fall back to host repo. ` +
      `Recovery: Recreate the task or recreate the workflow.`,
    );
  }

  // SSH tasks: run conflict resolution on the remote host
  if (task.config.familiarType === 'ssh' && task.config.remoteTargetId && !existsSync(rawCwd)) {
    const target = host.getRemoteTargetConfig?.(task.config.remoteTargetId);
    if (!target) {
      throw new Error(`No remote target config for "${task.config.remoteTargetId}" — cannot resolve conflict on remote`);
    }
    await resolveConflictRemote(host, task, taskBranch, conflictInfo, rawCwd, target, agentName);
    return;
  }

  // For local tasks (worktree, docker), require workspace path exists on disk
  if (task.config.familiarType !== 'ssh' && !existsSync(rawCwd)) {
    throw new Error(
      `resolveConflict: task "${taskId}" workspace does not exist on disk: ${rawCwd}. ` +
      `Refusing to run git operations without a valid workspace. ` +
      `Recovery: Recreate the task or recreate the workflow.`,
    );
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
      console.log(`[resolveConflict] Conflict reproduced for ${taskId}, spawning agent to resolve...`);

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

      await host.spawnAgentFix(prompt, cwd, agentName);
    }

    console.log(`[resolveConflict] Successfully resolved conflict for ${taskId}`);
  } catch (err) {
    try { await host.execGitIn(['merge', '--abort'], cwd); } catch { /* no merge in progress */ }
    try { await host.execGitIn(['checkout', originalBranch], cwd); } catch { /* best effort */ }
    throw err;
  }
}

/** Shell-quote a string for safe inclusion in a remote SSH command. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build the shell command to run an agent on a remote host.
 * Uses the agent registry when available; falls back to claude CLI.
 */
function buildRemoteAgentCommand(
  prompt: string,
  agentRegistry?: AgentRegistry,
  agentName?: string,
): { shellCommand: string; sessionId: string } {
  const name = agentName ?? 'claude';
  if (agentRegistry) {
    const agent = agentRegistry.get(name);
    if (agent?.buildFixCommand) {
      const spec = agent.buildFixCommand(prompt);
      const sessionId = spec.sessionId ?? randomUUID();
      const cmd = `${spec.cmd} ${spec.args.map(a => shellQuote(a)).join(' ')}`;
      return { shellCommand: cmd, sessionId };
    }
  }
  // Fallback: claude-compatible CLI (for backwards compat without registry)
  const sessionId = randomUUID();
  return {
    shellCommand: `claude --session-id ${shellQuote(sessionId)} -p ${shellQuote(prompt)} --dangerously-skip-permissions`,
    sessionId,
  };
}

async function resolveConflictRemote(
  host: ConflictResolverHost,
  task: ReturnType<Orchestrator['getTask']> & {},
  taskBranch: string,
  conflictInfo: { failedBranch: string; conflictFiles: string[] },
  remoteCwd: string,
  target: RemoteTargetConfig,
  agentName?: string,
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

  const { shellCommand: agentCmd } = buildRemoteAgentCommand(prompt, host.agentRegistry, agentName);
  const agentCmdB64 = Buffer.from(agentCmd).toString('base64');
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
  echo "[resolveConflict] Conflict reproduced, spawning agent to resolve..."
  eval "$(echo "${agentCmdB64}" | base64 -d)"
fi
`;

  await execRemoteSsh(target, script);
  console.log(`[resolveConflict] Successfully resolved remote conflict for ${task.id}`);
}

/**
 * Build the agent fix prompt based on task type.
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
 * Fix a failed command task by spawning an agent with the error output.
 * For SSH tasks, the agent runs on the remote host in the remote worktree.
 */
export async function fixWithAgentImpl(
  host: ConflictResolverHost,
  taskId: string,
  taskOutput: string,
  agentName?: string,
  savedError?: string,
): Promise<void> {
  const task = host.orchestrator.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== 'failed' && task.status !== 'running' && task.status !== 'fixing_with_ai') {
    throw new Error(`Task ${taskId} is not in a fixable state (status: ${task.status})`);
  }

  const taskForPrompt = savedError
    ? { ...task, execution: { ...task.execution, error: savedError } }
    : task;
  const prompt = buildFixPrompt(taskForPrompt, taskOutput);
  const workspacePath = task.execution.workspacePath;

  // SSH tasks: run agent on the remote host
  if (task.config.familiarType === 'ssh' && task.config.remoteTargetId && workspacePath && !existsSync(workspacePath)) {
    const target = host.getRemoteTargetConfig?.(task.config.remoteTargetId);
    if (!target) {
      throw new Error(`No remote target config for "${task.config.remoteTargetId}" — cannot fix on remote`);
    }
    const remoteAgentBin = agentName ?? 'claude';
    const { stdout: output, sessionId } = await spawnRemoteAgentFixImpl(prompt, workspacePath, target, agentName, host.agentRegistry);
    if (output) {
      host.persistence.appendTaskOutput(taskId, `\n[Fix with ${remoteAgentBin} (remote)] Output:\n${output}`);
    }
    host.persistence.updateTask(taskId, {
      execution: {
        agentSessionId: sessionId,
        lastAgentSessionId: sessionId,
        agentName: remoteAgentBin,
        lastAgentName: remoteAgentBin,
      },
    });
    console.log(`[fixWithAgent] Successfully applied remote fix for ${taskId} via ${remoteAgentBin} (session=${sessionId})`);
    return;
  }

  // Local tasks: require valid workspace before running agent
  if (!workspacePath) {
    throw new Error(
      `fixWithAgent: task "${taskId}" has no valid workspace ` +
      `(workspacePath=${workspacePath ?? 'undefined'}). ` +
      `All tasks must have a managed workspace; refusing to fall back to host repo. ` +
      `Recovery: Recreate the task or recreate the workflow.`,
    );
  }
  if (!existsSync(workspacePath)) {
    throw new Error(
      `fixWithAgent: task "${taskId}" has no valid workspace ` +
      `(workspacePath=${workspacePath ?? 'undefined'}). ` +
      `All tasks must have a managed workspace; refusing to fall back to host repo. ` +
      `Recovery: Recreate the task or recreate the workflow.`,
    );
  }
  const cwd = workspacePath;

  const agentLabel = agentName ?? 'claude';
  try {
    const { stdout: output, sessionId } = await host.spawnAgentFix(prompt, cwd, agentName);
    if (output) {
      host.persistence.appendTaskOutput(taskId, `\n[Fix with ${agentLabel}] Output:\n${output}`);
    }
    host.persistence.updateTask(taskId, {
      execution: {
        agentSessionId: sessionId,
        lastAgentSessionId: sessionId,
        agentName: agentLabel,
        lastAgentName: agentLabel,
      },
    });
    console.log(`[fixWithAgent] Successfully applied fix for ${taskId} via ${agentLabel} (session=${sessionId})`);
  } catch (err: any) {
    // Persist session ID even on failure so the session can be audited
    const failedSessionId = err?.sessionId as string | undefined;
    if (failedSessionId) {
      host.persistence.updateTask(taskId, {
        execution: {
          agentSessionId: failedSessionId,
          lastAgentSessionId: failedSessionId,
          agentName: agentLabel,
          lastAgentName: agentLabel,
        },
      });
      console.log(`[fixWithAgent] Fix failed for ${taskId} via ${agentLabel}, session persisted (session=${failedSessionId})`);
    }
    throw err;
  }
}


/**
 * Spawn an agent on a remote SSH host for fixing SSH-executed tasks.
 */
export function spawnRemoteAgentFixImpl(
  prompt: string,
  remoteCwd: string,
  target: RemoteTargetConfig,
  agentName?: string,
  agentRegistry?: AgentRegistry,
): Promise<{ stdout: string; sessionId: string }> {
  const promptTransport = materializeRemotePrompt(prompt);
  const { shellCommand: agentCmd, sessionId } = buildRemoteAgentCommand(
    promptTransport.effectivePrompt,
    agentRegistry,
    agentName,
  );
  const agentCmdB64 = Buffer.from(agentCmd).toString('base64');
  const promptWrite = promptTransport.remotePromptFilePath && promptTransport.promptB64
    ? [
        `PROMPT_FILE=${shellQuote(promptTransport.remotePromptFilePath)}`,
        `printf '%s' ${shellQuote(promptTransport.promptB64)} | base64 -d > "$PROMPT_FILE"`,
        `trap 'rm -f "$PROMPT_FILE"' EXIT`,
      ].join('\n') + '\n'
    : '';

const script = `set -euo pipefail
WT="${remoteCwd}"
if [[ "$WT" == '~' ]]; then WT="$HOME"; elif [[ "\${WT:0:2}" == '~/' ]]; then WT="$HOME/\${WT:2}"; fi
cd "$WT"
${promptWrite}
eval "$(echo "${agentCmdB64}" | base64 -d)"
`;

  const sshArgs = [
    '-i', target.sshKeyPath,
    '-p', String(target.port ?? 22),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    `${target.user}@${target.host}`,
    'bash', '-s',
  ];

  console.log(`[spawnAgentFix] remote agent command: ${agentCmd}`);
  console.log(`[spawnAgentFix] ssh: ssh ${sshArgs.join(' ')}`);
  console.log(`[spawnAgentFix] remote cwd: ${remoteCwd}`);
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
      // Replace local UUID with real backend session/thread ID for resume
      const driver = agentRegistry?.getSessionDriver(agentName ?? 'claude');
      const realId = driver?.extractSessionId?.(stdout);
      const effectiveSessionId = realId ?? sessionId;
      if (driver) {
        driver.processOutput(effectiveSessionId, stdout);
      }
      if (code === 0) resolve({ stdout, sessionId: effectiveSessionId });
      else reject(new Error(`Remote agent fix failed (exit ${code}): ${stderr.trim()}`));
    });
    child.on('error', (err) => reject(err));
  });
}

/**
 * Execute a bash script on a remote host via SSH. Throws on non-zero exit.
 */
/**
 * Spawn an agent fix using the registry-backed ExecutionAgent.buildFixCommand().
 */
export function spawnAgentFixViaRegistry(
  prompt: string,
  cwd: string,
  agent: ExecutionAgent,
  driver?: SessionDriver,
): Promise<{ stdout: string; sessionId: string }> {
  const promptTransport = materializeLocalPrompt(prompt);
  const spec = agent.buildFixCommand?.(promptTransport.effectivePrompt);
  if (!spec) {
    promptTransport.cleanup();
    throw new Error(`Agent "${agent.name}" does not support fix commands`);
  }
  const sessionId = spec.sessionId ?? randomUUID();
  console.log(`[spawnAgentFix] cmd: ${spec.cmd} ${spec.args.map(a => JSON.stringify(a)).join(' ')}`);
  console.log(`[spawnAgentFix] cwd: ${cwd}`);
  return new Promise<{ stdout: string; sessionId: string }>((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanElectronEnv(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      // Extract real backend session/thread ID BEFORE writing the file,
      // so processOutput stores under the real ID (not the local UUID).
      const realId = driver?.extractSessionId?.(stdout);
      const effectiveSessionId = realId ?? sessionId;
      const displayStdout = driver ? driver.processOutput(effectiveSessionId, stdout) : stdout;
      if (code === 0) {
        promptTransport.cleanup();
        resolve({ stdout: displayStdout, sessionId: effectiveSessionId });
      } else {
        promptTransport.cleanup();
        reject(Object.assign(
          new Error(`${agent.name} fix exited with code ${code}: ${stderr.trim()}`),
          { sessionId: effectiveSessionId },
        ));
      }
    });
    child.on('error', (err) => {
      promptTransport.cleanup();
      reject(err);
    });
  });
}

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
