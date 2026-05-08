import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import type { ExecutionAgent } from './agent.js';
import type { SessionDriver } from './session-driver.js';
import { cleanElectronEnv } from './process-utils.js';

// ── Structured PR-authoring context ──────────────────────

/** Per-task evidence carried through PR authoring. */
export interface PrAuthoringTaskEntry {
  taskId: string;
  description: string;
  status: 'completed' | 'failed' | 'skipped';
  /** Shell command executed for command-type tasks. */
  command?: string;
  /** Per-task file-change summary (e.g. `git diff --stat` output). */
  fileChangeSummary?: string;
}

/**
 * Structured context that supplements the free-form `workflowSummary` string
 * with machine-readable evidence for PR body authoring.
 *
 * Both AI-authored and deterministic-fallback paths can consume this.
 */
export interface PrAuthoringContext {
  /** Workflow name (human-readable). */
  workflowName?: string;
  /** Workflow description from plan YAML. */
  workflowDescription?: string;
  /** Per-task entries with verification evidence. */
  tasks: PrAuthoringTaskEntry[];
  /** Visual-proof markdown block (screenshots / video walkthrough). */
  visualProofMarkdown?: string;
}

const REQUIRED_SECTIONS = ['## Summary', '## Test Plan', '## Revert Plan'] as const;
const DISCOURAGED_HEADINGS = ['## Testing', '## Notes'] as const;
const DEFAULT_MAX_INLINE_PROMPT_BYTES = 64 * 1024;
const MAX_INLINE_PROMPT_BYTES = (() => {
  const raw = process.env.INVOKER_MAX_INLINE_AGENT_PROMPT_BYTES;
  if (!raw) return DEFAULT_MAX_INLINE_PROMPT_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_INLINE_PROMPT_BYTES;
})();

export function validateCanonicalPrBody(body: string): string[] {
  const errors: string[] = [];
  const trimmed = body.trim();

  if (!trimmed) {
    return [
      'PR body is empty. Use the canonical schema: ## Summary, ## Test Plan, ## Revert Plan, plus optional ## Architecture.',
    ];
  }

  for (const heading of REQUIRED_SECTIONS) {
    if (!trimmed.includes(heading)) {
      errors.push(`Missing required section: ${heading}`);
    }
  }

  for (const heading of DISCOURAGED_HEADINGS) {
    if (trimmed.includes(heading)) {
      errors.push(
        `Unsupported section: ${heading}. Do not use the lightweight PR format; use ## Test Plan and ## Revert Plan instead.`,
      );
    }
  }

  if (trimmed.includes('## Architecture')) {
    for (const subsection of ['### Before', '### After']) {
      if (!trimmed.includes(subsection)) {
        errors.push(`Architecture section is missing required subsection: ${subsection}`);
      }
    }
  }

  return errors;
}

function promptByteLength(prompt: string): number {
  return Buffer.byteLength(prompt, 'utf8');
}

function buildPromptFileBootstrap(promptPath: string): string {
  return [
    `The full task instructions are in this file: ${promptPath}`,
    'Read the file completely, then execute those instructions in this workspace.',
    'Do not ask for the file contents.',
  ].join('\n');
}

function materializeLocalPrompt(prompt: string): { effectivePrompt: string; cleanup: () => void } {
  if (promptByteLength(prompt) <= MAX_INLINE_PROMPT_BYTES) {
    return { effectivePrompt: prompt, cleanup: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), 'invoker-pr-author-prompt-'));
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

function extractAssistantBody(driver: SessionDriver | undefined, sessionId: string, fallback: string): string {
  const rawSession = driver?.loadSession(sessionId);
  if (rawSession && driver) {
    const messages = driver.parseSession(rawSession);
    for (let idx = messages.length - 1; idx >= 0; idx--) {
      const message = messages[idx];
      if (message?.role === 'assistant' && message.content.trim()) {
        return message.content.trim();
      }
    }
  }
  return fallback.trim();
}

export function resolveInstalledSkillPathForAgent(agentName: string, skillName: string): string | null {
  const normalized = agentName.trim().toLowerCase();
  const home = homedir();
  const skillDir = normalized === 'codex'
    ? join(home, '.codex', 'skills', `invoker-${skillName}`)
    : normalized === 'claude'
      ? join(home, '.claude', 'skills', `invoker-${skillName}`)
      : null;
  if (!skillDir) return null;
  return existsSync(join(skillDir, 'SKILL.md')) ? skillDir : null;
}

/**
 * Resolve skill path using the agent's own `bundledSkillRoot` metadata.
 * Falls back to `resolveInstalledSkillPathForAgent` for agents without metadata.
 */
export function resolveSkillPathViaAgent(agent: ExecutionAgent, skillName: string): string | null {
  if (agent.bundledSkillRoot) {
    const skillDir = join(agent.bundledSkillRoot, `invoker-${skillName}`);
    if (existsSync(join(skillDir, 'SKILL.md'))) return skillDir;
  }
  return resolveInstalledSkillPathForAgent(agent.name, skillName);
}

/**
 * Build a deterministic canonical PR body from structured context.
 * Used as the no-AI escape hatch when all agent-authored attempts fail.
 */
export function buildCanonicalPrBody(args: {
  title: string;
  workflowSummary: string;
  structuredContext?: PrAuthoringContext;
}): string {
  const lines: string[] = [];

  // ## Summary
  lines.push('## Summary');
  lines.push('');
  if (args.structuredContext?.workflowDescription) {
    lines.push(args.structuredContext.workflowDescription);
  } else {
    lines.push(args.workflowSummary.trim());
  }
  lines.push('');

  // ## Test Plan
  lines.push('## Test Plan');
  lines.push('');
  const ctx = args.structuredContext;
  const commandTasks = ctx?.tasks.filter((t) => t.command && t.status === 'completed') ?? [];
  if (commandTasks.length > 0) {
    for (const t of commandTasks) {
      lines.push(`- [x] \`${t.command}\` — ${t.description}`);
    }
  } else {
    lines.push('- [ ] Manual verification required');
  }
  lines.push('');

  // ## Revert Plan
  lines.push('## Revert Plan');
  lines.push('');
  lines.push('- Safe to revert? Yes');
  lines.push('- Revert command: `git revert <sha>`');
  lines.push('- Post-revert steps: None');
  lines.push('- Data migration? No');
  lines.push('');

  // Visual proof (preserve verbatim if present)
  if (ctx?.visualProofMarkdown) {
    lines.push(ctx.visualProofMarkdown);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function buildMakePrPrompt(args: {
  skillPath: string;
  title: string;
  baseBranch: string;
  featureBranch: string;
  workflowSummary: string;
  structuredContext?: PrAuthoringContext;
}): string {
  const lines = [
    `You are authoring the GitHub PR body for the branch "${args.featureBranch}" targeting "${args.baseBranch}".`,
    '',
    `Use the installed skill "invoker-make-pr" at: ${args.skillPath}`,
    'Read that SKILL.md first and follow it exactly.',
    '',
    'Requirements:',
    `- The PR title is already decided: "${args.title}"`,
    '- Output only the final PR body markdown. Do not include commentary, explanations, or code fences.',
    '- Use the repo-local PR conventions and tooling referenced by the skill.',
    '- Only include `## Architecture` when the change modifies component interactions, control flow, state flow, or data flow.',
    '- If the change is small and has no architectural impact, omit `## Architecture`.',
    '- Ensure the final body satisfies the canonical schema required by this repo.',
    '',
    'You may inspect the working tree, git diff, `scripts/pr-body-template.md`, and `scripts/validate-pr-body.mjs` before writing.',
    '',
    'Merge workflow context:',
    '```md',
    args.workflowSummary.trim(),
    '```',
  ];

  const ctx = args.structuredContext;
  if (ctx) {
    lines.push('');
    lines.push('Structured workflow evidence (use to enrich your PR body):');
    lines.push('');

    const commandTasks = ctx.tasks.filter((t) => t.command && t.status === 'completed');
    if (commandTasks.length > 0) {
      lines.push('Executed verification commands:');
      for (const t of commandTasks) {
        lines.push(`- \`${t.command}\` — ${t.description} (${t.status})`);
      }
      lines.push('');
    }

    const withFiles = ctx.tasks.filter((t) => t.fileChangeSummary);
    if (withFiles.length > 0) {
      lines.push('File-change summaries:');
      for (const t of withFiles) {
        lines.push(`### ${t.taskId} — ${t.description}`);
        lines.push(t.fileChangeSummary!);
        lines.push('');
      }
    }

    if (ctx.visualProofMarkdown) {
      lines.push('Visual proof (include verbatim in PR body if present):');
      lines.push(ctx.visualProofMarkdown);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function spawnAgentPrAuthorViaRegistry(
  prompt: string,
  cwd: string,
  agent: ExecutionAgent,
  driver?: SessionDriver,
): Promise<{ body: string; stdout: string; sessionId: string }> {
  const promptTransport = materializeLocalPrompt(prompt);
  const spec = agent.buildCommand(promptTransport.effectivePrompt);
  const sessionId = spec.sessionId ?? randomUUID();

  return new Promise<{ body: string; stdout: string; sessionId: string }>((resolve, reject) => {
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
      const realId = driver?.extractSessionId?.(stdout);
      const effectiveSessionId = realId ?? sessionId;
      const displayStdout = driver ? driver.processOutput(effectiveSessionId, stdout) : stdout;
      if (code === 0) {
        const body = extractAssistantBody(driver, effectiveSessionId, displayStdout);
        promptTransport.cleanup();
        resolve({ body, stdout: displayStdout, sessionId: effectiveSessionId });
        return;
      }
      promptTransport.cleanup();
      reject(new Error(`${agent.name} PR authoring exited with code ${code}: ${stderr.trim()}`));
    });
    child.on('error', (err) => {
      promptTransport.cleanup();
      reject(err);
    });
  });
}
