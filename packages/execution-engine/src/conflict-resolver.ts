/**
 * Conflict resolution logic, extracted from TaskRunner.
 *
 * Each function takes a ConflictResolverHost (a subset of TaskRunner's
 * capabilities) as its first parameter, avoiding circular imports.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Orchestrator } from '@invoker/workflow-core';
import { OrchestratorError, OrchestratorErrorCode, parseMergeConflictError } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import { buildAgentExitFailureDetail, cleanElectronEnv, resolveExecutableOnCurrentPath } from './process-utils.js';
import { assertExecutionModelSupported, DEFAULT_EXECUTION_AGENT, type ExecutionAgent } from './agent.js';
import type { SessionDriver } from './session-driver.js';
import type { AgentRegistry } from './agent-registry.js';
import { buildWorktreeListScript, createSshRemoteScriptError } from './ssh-git-exec.js';
import { buildSshConnectionArgs } from './ssh-transport-options.js';
import { findManagedWorktreeForBranch } from './worktree-discovery.js';
import { buildRemoteAgentEnvExports } from './remote-agent-env.js';

// ── Host interface ───────────────────────────────────────

export interface RemoteTargetConfig {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
  managedWorkspaces?: boolean;
  remoteInvokerHome?: string;
  use_api_key?: boolean;
  secretsFile?: string;
}

/**
 * Subset of TaskRunner that conflict resolution functions need.
 * Defined here (not by importing TaskRunner) to avoid circular deps.
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
  spawnAgentFix(prompt: string, cwd: string, agentName?: string, executionModel?: string): Promise<{ stdout: string; sessionId: string }>;
  getRemoteTargetConfig?(targetId: string): RemoteTargetConfig | undefined;
}

const DEFAULT_MAX_INLINE_PROMPT_BYTES = 64 * 1024;
const MAX_INLINE_PROMPT_BYTES = (() => {
  const raw = process.env.INVOKER_MAX_INLINE_AGENT_PROMPT_BYTES;
  if (!raw) return DEFAULT_MAX_INLINE_PROMPT_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_INLINE_PROMPT_BYTES;
})();
const DEBUG_IO_TAIL_CHARS = 2000;

function tailText(value: unknown, maxChars: number = DEBUG_IO_TAIL_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= maxChars) return value;
  return value.slice(-maxChars);
}

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

function deriveRemoteManagedWorkspaceInfo(
  workspacePath: string,
  target: RemoteTargetConfig,
): { repoHash: string; invokerHome: string; managedPrefix: string } | undefined {
  const normalized = workspacePath === '~'
    ? `~`
    : workspacePath.endsWith('/')
    ? workspacePath.slice(0, -1)
    : workspacePath;
  const match = normalized.match(/^(.*)\/worktrees\/([a-f0-9]{12})\/[^/]+$/);
  if (match) {
    return {
      invokerHome: match[1] || target.remoteInvokerHome || `~/.invoker`,
      repoHash: match[2],
      managedPrefix: `${match[1]}/worktrees/${match[2]}`,
    };
  }

  if (!target.remoteInvokerHome) return undefined;
  const hashMatch = normalized.match(/\/worktrees\/([a-f0-9]{12})\/[^/]+$/);
  if (!hashMatch) return undefined;
  return {
    invokerHome: target.remoteInvokerHome,
    repoHash: hashMatch[1],
    managedPrefix: `${target.remoteInvokerHome}/worktrees/${hashMatch[1]}`,
  };
}

export async function resolveRemoteBranchOwnerPath(
  branch: string | undefined,
  workspacePath: string,
  target: RemoteTargetConfig,
): Promise<string | undefined> {
  if (!branch) return undefined;
  const info = deriveRemoteManagedWorkspaceInfo(workspacePath, target);
  if (!info) return undefined;
  try {
    const porcelain = await execRemoteSsh(
      target,
      buildWorktreeListScript({
        repoHash: info.repoHash,
        invokerHome: info.invokerHome,
      }),
      'list_worktrees',
    );
    return findManagedWorktreeForBranch(porcelain, branch, [info.managedPrefix]);
  } catch {
    return undefined;
  }
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
  resolvedExecutionModel?: string,
): Promise<void> {
  host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
    phase: 'resolve-conflict-start',
    agent: agentName ?? DEFAULT_EXECUTION_AGENT,
    hasSavedError: savedError !== undefined,
  });
  const task = host.orchestrator.getTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  if (task.status !== 'failed' && task.status !== 'running' && task.status !== 'fixing_with_ai') {
    throw new Error(`Task ${taskId} is not in a resolvable state (status: ${task.status})`);
  }

  const errorStr = savedError ?? task.execution.error;
  if (!errorStr) throw new Error(`Task ${taskId} has no error information`);

  const conflictInfo = parseMergeConflictError(errorStr);
  if (!conflictInfo) {
    host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'resolve-conflict-parse-failed',
      errorPreview: String(errorStr).slice(0, 400),
    });
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
  const poolMemberId = resolveSelectedRemoteTargetId(host, taskId, task);
  if (task.config.runnerKind === 'ssh' && poolMemberId && !existsSync(rawCwd)) {
    host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'resolve-conflict-remote-path',
      poolMemberId,
      workspacePath: rawCwd,
    });
    const target = host.getRemoteTargetConfig?.(poolMemberId);
    if (!target) {
      throw new Error(`No remote target config for "${poolMemberId}" — cannot resolve conflict on remote`);
    }
    await resolveConflictRemote(host, task, taskBranch, conflictInfo, rawCwd, target, agentName, resolvedExecutionModel);
    return;
  }

  // For local tasks (worktree, docker), require workspace path exists on disk
  if (task.config.runnerKind !== 'ssh' && !existsSync(rawCwd)) {
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
      host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
        phase: 'resolve-conflict-merge-retry-succeeded',
        failedBranch: conflictInfo.failedBranch,
      });
    } catch {
      console.log(`[resolveConflict] Conflict reproduced for ${taskId}, spawning agent to resolve...`);
      host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
        phase: 'resolve-conflict-spawn-agent',
        failedBranch: conflictInfo.failedBranch,
        conflictFiles: conflictInfo.conflictFiles,
      });

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
      const executionModel = resolvedExecutionModel ?? resolveExecutionModelForAgent(task, agentName);
      await host.spawnAgentFix(prompt, cwd, agentName, executionModel);
    }

    console.log(`[resolveConflict] Successfully resolved conflict for ${taskId}`);
    host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'resolve-conflict-success',
      failedBranch: conflictInfo.failedBranch,
    });
  } catch (err) {
    const errAny = err as any;
    host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'resolve-conflict-failed',
      errorType: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
      exitCode: typeof errAny?.exitCode === 'number' ? errAny.exitCode : null,
      cmd: typeof errAny?.cmd === 'string' ? errAny.cmd : null,
      args: Array.isArray(errAny?.args) ? errAny.args : null,
      stdoutTail: tailText(errAny?.stdoutTail ?? errAny?.stdout),
      stderrTail: tailText(errAny?.stderrTail ?? errAny?.stderr),
    });
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
 * Remote `bash -s` invocation for an agent command, forwarding the local PATH so
 * a bare agent binary (e.g. `codex`) resolves on the remote — mirroring how
 * ssh-executor runs task payloads. Without this the fix/resolve agent dies with
 * "command not found" even though normal task execution on the same host works.
 */
export function remoteAgentShellInvocation(remotePath: string = process.env.PATH ?? ''): string[] {
  return remotePath ? ['env', `PATH=${remotePath}`, 'bash', '-s'] : ['bash', '-s'];
}

/**
 * Build the shell command to run an agent on a remote host.
 * Uses the agent registry when available; falls back to claude CLI.
 */
function buildRemoteAgentCommand(
  prompt: string,
  agentRegistry?: AgentRegistry,
  agentName?: string,
  executionModel?: string,
): { shellCommand: string; sessionId: string } {
  const name = agentName ?? DEFAULT_EXECUTION_AGENT;
  if (agentRegistry) {
    const agent = agentRegistry.get(name);
    if (agent?.buildFixCommand) {
      const spec = agent.buildFixCommand(prompt, { executionModel });
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

export function resolveSelectedRemoteTargetId(host: ConflictResolverHost, taskId: string, task: ReturnType<Orchestrator['getTask']> & {}): string | undefined {
  const direct = (task.config as { poolMemberId?: string }).poolMemberId;
  if (direct) return direct;

  const events = host.persistence.getEvents?.(taskId) ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.eventType !== 'task.executor.selected' || !event.payload) continue;
    try {
      const payload = JSON.parse(event.payload) as { poolMemberId?: unknown };
      if (typeof payload.poolMemberId === 'string' && payload.poolMemberId.trim()) {
        return payload.poolMemberId;
      }
    } catch {
      // Ignore malformed historical diagnostics.
    }
  }

  return undefined;
}

function resolveExecutionModelForAgent(
  task: ReturnType<Orchestrator['getTask']> & {},
  agentName?: string,
): string | undefined {
  const taskAgent = task.config.executionAgent?.trim();
  const effectiveAgent = agentName?.trim() ?? taskAgent;
  if (!taskAgent || !effectiveAgent || effectiveAgent !== taskAgent) return undefined;
  const executionModel = task.config.executionModel?.trim();
  return executionModel || undefined;
}

async function resolveConflictRemote(
  host: ConflictResolverHost,
  task: ReturnType<Orchestrator['getTask']> & {},
  taskBranch: string,
  conflictInfo: { failedBranch: string; conflictFiles: string[] },
  remoteCwd: string,
  target: RemoteTargetConfig,
  agentName?: string,
  resolvedExecutionModel?: string,
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

  const executionModel = resolvedExecutionModel ?? resolveExecutionModelForAgent(task, agentName);
  const { shellCommand: agentCmd } = buildRemoteAgentCommand(
    prompt,
    host.agentRegistry,
    agentName,
    executionModel,
  );
  const agentCmdB64 = Buffer.from(agentCmd).toString('base64');
  const mergeMsgB64 = Buffer.from(conflictMergeMsg).toString('base64');
  const envExports = buildRemoteAgentEnvExports(target.secretsFile, target.use_api_key === true);

  const script = `set -euo pipefail
WT="${remoteCwd}"
if [[ "$WT" == '~' ]]; then WT="$HOME"; elif [[ "\${WT:0:2}" == '~/' ]]; then WT="$HOME/\${WT:2}"; fi
cd "$WT"
${envExports}
git checkout "${taskBranch}"
MERGE_MSG=$(echo "${mergeMsgB64}" | base64 -d)
if git merge --no-edit -m "$MERGE_MSG" "${conflictInfo.failedBranch}" 2>/dev/null; then
  echo "[resolveConflict] Merge succeeded without conflict on retry"
else
  echo "[resolveConflict] Conflict reproduced, spawning agent to resolve..."
  eval "$(echo "${agentCmdB64}" | base64 -d)"
fi
`;

  const sshArgs = [
    ...buildSshConnectionArgs({
      sshKeyPath: target.sshKeyPath,
      port: target.port,
      user: target.user,
      host: target.host,
    }, { batchMode: true }),
    ...remoteAgentShellInvocation(),
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ssh', sshArgs, { stdio: ['pipe', 'inherit', 'inherit'], env: cleanElectronEnv() });
    child.stdin?.write(script);
    child.stdin?.end();
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ssh conflict resolve failed (exit=${code})`)));
    child.on('error', reject);
  });
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
  fixContext?: string,
): Promise<void> {
  host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
    phase: 'fix-with-agent-start',
    agent: agentName ?? DEFAULT_EXECUTION_AGENT,
    hasSavedError: savedError !== undefined,
    outputLength: taskOutput.length,
  });
  const task = host.orchestrator.getTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  if (task.status !== 'failed' && task.status !== 'running' && task.status !== 'fixing_with_ai') {
    throw new Error(`Task ${taskId} is not in a fixable state (status: ${task.status})`);
  }

  const taskForPrompt = savedError
    ? { ...task, execution: { ...task.execution, error: savedError } }
    : task;
  const basePrompt = buildFixPrompt(taskForPrompt, taskOutput);
  const prompt = fixContext?.trim()
    ? `${basePrompt}\n\nAdditional fix context:\n${fixContext.trim()}`
    : basePrompt;
  const workspacePath = task.execution.workspacePath;
  const executionModel = resolveExecutionModelForAgent(task, agentName);

  const poolMemberId = resolveSelectedRemoteTargetId(host, taskId, task);
  if (task.config.runnerKind === 'ssh' && poolMemberId && workspacePath && !existsSync(workspacePath)) {
    host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'fix-with-agent-remote-path',
      poolMemberId,
      workspacePath,
    });
    const target = host.getRemoteTargetConfig?.(poolMemberId);
    if (!target) {
      throw new Error(`No remote target config for "${poolMemberId}" — cannot fix on remote`);
    }
    const resolvedWorkspacePath =
      (await resolveRemoteBranchOwnerPath(task.execution.branch, workspacePath, target)) ?? workspacePath;
    if (resolvedWorkspacePath !== workspacePath) {
      host.persistence.updateTask(taskId, {
        execution: {
          workspacePath: resolvedWorkspacePath,
        },
      });
      host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
        phase: 'fix-with-agent-remote-path-repaired',
        previousWorkspacePath: workspacePath,
        repairedWorkspacePath: resolvedWorkspacePath,
      });
    }
    const remoteAgentBin = agentName ?? DEFAULT_EXECUTION_AGENT;
    const { stdout: output, sessionId } = await spawnRemoteAgentFixImpl(
      prompt,
      resolvedWorkspacePath,
      target,
      agentName,
      host.agentRegistry,
      executionModel,
    );
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
    host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'fix-with-agent-success',
      mode: 'remote',
      sessionId,
      agent: remoteAgentBin,
    });
    return;
  }

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

  const agentLabel = agentName ?? DEFAULT_EXECUTION_AGENT;
  try {
    host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'fix-with-agent-spawn-local',
      workspacePath: cwd,
      agent: agentLabel,
    });
    const { stdout: output, sessionId } = await host.spawnAgentFix(prompt, cwd, agentName, executionModel);
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
    host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'fix-with-agent-success',
      mode: 'local',
      sessionId,
      agent: agentLabel,
    });
  } catch (err) {
    const failedSessionId = err && typeof err === 'object' && 'sessionId' in err && typeof err.sessionId === 'string'
      ? err.sessionId
      : undefined;
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
    const errorRecord = err && typeof err === 'object' ? err : undefined;
    const exitCode = errorRecord && 'exitCode' in errorRecord && typeof errorRecord.exitCode === 'number'
      ? errorRecord.exitCode
      : null;
    const cmd = errorRecord && 'cmd' in errorRecord && typeof errorRecord.cmd === 'string'
      ? errorRecord.cmd
      : null;
    const args = errorRecord && 'args' in errorRecord && Array.isArray(errorRecord.args)
      ? errorRecord.args
      : null;
    const stdoutTail = errorRecord && 'stdoutTail' in errorRecord
      ? tailText(errorRecord.stdoutTail)
      : errorRecord && 'stdout' in errorRecord
        ? tailText(errorRecord.stdout)
        : undefined;
    const stderrTail = errorRecord && 'stderrTail' in errorRecord
      ? tailText(errorRecord.stderrTail)
      : errorRecord && 'stderr' in errorRecord
        ? tailText(errorRecord.stderr)
        : undefined;
    host.persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'fix-with-agent-failed',
      agent: agentLabel,
      sessionId: failedSessionId ?? null,
      errorType: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
      exitCode,
      cmd,
      args,
      stdoutTail,
      stderrTail,
    });
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
  executionModel?: string,
): Promise<{ stdout: string; sessionId: string }> {
  const promptTransport = materializeRemotePrompt(prompt);
  const { shellCommand: agentCmd, sessionId } = buildRemoteAgentCommand(
    promptTransport.effectivePrompt,
    agentRegistry,
    agentName,
    executionModel,
  );
  const agentCmdB64 = Buffer.from(agentCmd).toString('base64');
  const promptWrite = promptTransport.remotePromptFilePath && promptTransport.promptB64
    ? [
        `PROMPT_FILE=${shellQuote(promptTransport.remotePromptFilePath)}`,
        `printf '%s' ${shellQuote(promptTransport.promptB64)} | base64 -d > "$PROMPT_FILE"`,
        `trap 'rm -f "$PROMPT_FILE"' EXIT`,
      ].join('\n') + '\n'
    : '';
  const envExports = buildRemoteAgentEnvExports(target.secretsFile, target.use_api_key === true);

  const script = `set -euo pipefail
WT="${remoteCwd}"
if [[ "$WT" == '~' ]]; then WT="$HOME"; elif [[ "\${WT:0:2}" == '~/' ]]; then WT="$HOME/\${WT:2}"; fi
cd "$WT"
${envExports}
${promptWrite}
eval "$(echo "${agentCmdB64}" | base64 -d)"
`;

  const sshArgs = [
    ...buildSshConnectionArgs({
      sshKeyPath: target.sshKeyPath,
      port: target.port,
      user: target.user,
      host: target.host,
    }, { batchMode: true }),
    ...remoteAgentShellInvocation(),
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
      const driver = agentRegistry?.getSessionDriver(agentName ?? DEFAULT_EXECUTION_AGENT);
      const realId = driver?.extractSessionId?.(stdout);
      const effectiveSessionId = realId ?? sessionId;
      if (driver) {
        driver.processOutput(effectiveSessionId, stdout);
      }
      if (code === 0) resolve({ stdout, sessionId: effectiveSessionId });
      else reject(createSshRemoteScriptError(code, stdout, stderr, 'remote_agent_fix'));
    });
    child.on('error', (err) => reject(err));
  });
}

/**
 * Spawn an agent fix using the registry-backed ExecutionAgent.buildFixCommand().
 */
export function spawnAgentFixViaRegistry(
  prompt: string,
  cwd: string,
  agent: ExecutionAgent,
  driver?: SessionDriver,
  executionModel?: string,
): Promise<{ stdout: string; sessionId: string }> {
  assertExecutionModelSupported(agent, executionModel);
  const promptTransport = materializeLocalPrompt(prompt);
  const spec = agent.buildFixCommand?.(promptTransport.effectivePrompt, { executionModel });
  if (!spec) {
    promptTransport.cleanup();
    throw new Error(`Agent "${agent.name}" does not support fix commands`);
  }
  const sessionId = spec.sessionId ?? randomUUID();
  const cmd = resolveExecutableOnCurrentPath(spec.cmd) ?? spec.cmd;
  console.log(`[spawnAgentFix] cmd: ${cmd} ${spec.args.map(a => JSON.stringify(a)).join(' ')}`);
  console.log(`[spawnAgentFix] cwd: ${cwd}`);
  return new Promise<{ stdout: string; sessionId: string }>((resolve, reject) => {
    const child = spawn(cmd, spec.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanElectronEnv(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      const realId = driver?.extractSessionId?.(stdout);
      const effectiveSessionId = realId ?? sessionId;
      const displayStdout = driver ? driver.processOutput(effectiveSessionId, stdout) : stdout;
      if (code === 0) {
        promptTransport.cleanup();
        resolve({ stdout: displayStdout, sessionId: effectiveSessionId });
      } else {
        promptTransport.cleanup();
        reject(Object.assign(
          new Error(`${agent.name} fix exited with code ${code}: ${buildAgentExitFailureDetail(stdout, stderr, displayStdout)}`),
          {
            sessionId: effectiveSessionId,
            exitCode: code,
            cmd: spec.cmd,
            args: spec.args,
            stdoutTail: tailText(stdout),
            stderrTail: tailText(stderr),
            cwd,
          },
        ));
      }
    });
    child.on('error', (err) => {
      promptTransport.cleanup();
      reject(Object.assign(err, {
        cmd: spec.cmd,
        args: spec.args,
        stdoutTail: tailText(stdout),
        stderrTail: tailText(stderr),
        cwd,
      }));
    });
  });
}

function execRemoteSsh(target: RemoteTargetConfig, script: string, phase?: string): Promise<string> {
  const sshArgs = [
    ...buildSshConnectionArgs({
      sshKeyPath: target.sshKeyPath,
      port: target.port,
      user: target.user,
      host: target.host,
    }, { batchMode: true }),
    ...remoteAgentShellInvocation(),
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
      else reject(createSshRemoteScriptError(code, stdout, stderr, phase));
    });
    child.on('error', (err) => reject(err));
  });
}
