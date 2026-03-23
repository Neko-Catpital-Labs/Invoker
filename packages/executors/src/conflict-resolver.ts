/**
 * Conflict resolution logic, extracted from TaskExecutor.
 *
 * Each function takes a ConflictResolverHost (a subset of TaskExecutor's
 * capabilities) as its first parameter, avoiding circular imports.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { Orchestrator } from '@invoker/core';
import type { SQLiteAdapter } from '@invoker/persistence';

// ── Host interface ───────────────────────────────────────

/**
 * Subset of TaskExecutor that conflict resolution functions need.
 * Defined here (not by importing TaskExecutor) to avoid circular deps.
 */
export interface ConflictResolverHost {
  readonly orchestrator: Orchestrator;
  readonly persistence: SQLiteAdapter;
  readonly cwd: string;

  execGit(args: string[], cwd?: string): Promise<string>;
  spawnClaudeFix(prompt: string, cwd: string): Promise<{ stdout: string; sessionId: string }>;
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
  const cwd = task.execution.workspacePath ?? host.cwd;
  const originalBranch = await host.execGit(['branch', '--show-current'], cwd);

  try {
    // Checkout the task branch
    try {
      await host.execGit(['checkout', taskBranch], cwd);
    } catch {
      throw new Error(`Cannot checkout task branch ${taskBranch}`);
    }

    // Re-merge the conflicting upstream branch (will reproduce the conflict)
    try {
      const depTask = host.orchestrator.getAllTasks().find(t => t.execution.branch === conflictInfo.failedBranch);
      const conflictMergeMsg = depTask?.description
        ? `Merge upstream ${conflictInfo.failedBranch} — ${depTask.description}`
        : `Merge upstream ${conflictInfo.failedBranch}`;
      await host.execGit(['merge', '--no-edit', '-m', conflictMergeMsg, conflictInfo.failedBranch], cwd);
      console.log(`[resolveConflict] Merge succeeded without conflict on retry for ${taskId}`);
    } catch {
      // Expected: conflict reproduced — now spawn Claude to resolve it
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
    // Clean up on failure
    try { await host.execGit(['merge', '--abort'], cwd); } catch { /* no merge in progress */ }
    try { await host.execGit(['checkout', originalBranch], cwd); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Build the Claude fix prompt based on task type.
 *
 * - Merge-gate tasks get a merge-conflict-focused prompt.
 * - Command tasks get the existing command-focused prompt.
 * - Prompt-only / other tasks get a generic failure prompt.
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
 * Claude's output is captured and appended to the task's output stream for auditing.
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

  const cwd = task.execution.workspacePath ?? host.cwd;

  const prompt = buildFixPrompt(task, taskOutput);

  const { stdout: output, sessionId } = await host.spawnClaudeFix(prompt, cwd);
  if (output) {
    host.persistence.appendTaskOutput(taskId, `\n[Fix with Claude] Output:\n${output}`);
  }
  host.persistence.updateTask(taskId, { execution: { claudeSessionId: sessionId } });
  console.log(`[fixWithClaude] Successfully applied fix for ${taskId} (session=${sessionId})`);
}

/**
 * Spawn Claude subprocess for fixes.
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
