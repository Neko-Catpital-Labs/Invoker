import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import type { ExecutionAgent } from './agent.js';
import type { SessionDriver } from './session-driver.js';
import { cleanElectronEnv, resolveExecutableOnCurrentPath } from './process-utils.js';

export interface MakePrStackArtifactOutput {
  readonly id: string;
  readonly title?: string;
  readonly url: string;
  readonly providerId?: string;
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly dependsOn?: readonly string[];
}

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

const INVOKER_REPO_OWNER_RE = /^(neko-catpital-labs|edbertchan)$/i;

export function isInvokerRepoUrl(repoUrl: string | undefined): boolean {
  if (!repoUrl) return false;
  const trimmed = repoUrl.trim();
  const httpsMatch = /^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/i.exec(trimmed);
  const sshMatch = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/.]+)(?:\.git)?$/i.exec(trimmed);
  const match = httpsMatch ?? sshMatch;
  if (!match) return false;
  const [, owner, repo] = match;
  return INVOKER_REPO_OWNER_RE.test(owner) && repo.toLowerCase() === 'invoker';
}

export function buildMakePrStackPublishPrompt(args: {
  skillPath: string;
  title: string;
  baseBranch: string;
  featureBranch: string;
  workflowSummary: string;
  cwd: string;
  reviewGate?: unknown;
}): string {
  const lines = [
    `Publish the Invoker-on-Invoker review PR stack for branch "${args.featureBranch}" targeting "${args.baseBranch}".`,
    '',
    `Use the installed skill "invoker-make-pr" at: ${args.skillPath}`,
    'Read invoker-make-pr/SKILL.md first and follow the repo-local PR workflow exactly.',
    'Use Mergify stack publication for this Invoker stack.',
    '',
    'Requirements:',
    `- PR title prefix/base title: "${args.title}"`,
    `- Repository working directory: ${args.cwd}`,
    '- Use the repo-local PR workflow and validation tools from the skill.',
    '- Output only JSON. Do not include markdown, commentary, explanations, or code fences.',
    '- The JSON shape must be exactly:',
    '{"artifacts":[{"id":"string","title":"string","url":"string","providerId":"string","branch":"string","baseBranch":"string","dependsOn":["string"]}]}',
    '- artifacts are already listed in stack order.',
    '- artifacts[0].dependsOn must be omitted or [].',
    '- For every i > 0, artifacts[i].dependsOn must be exactly [artifacts[i - 1].id].',
    '- Do not emit branches, merges, skipped predecessors, or multiple dependencies.',
    '- Do not add fixed PR-count fields.',
    '- Do not add Mergify-specific fields to the JSON.',
    '',
    'Workflow summary:',
    '```md',
    args.workflowSummary.trim(),
    '```',
  ];
  if (args.reviewGate) {
    lines.push('', 'Existing review-gate intent:', '```json', JSON.stringify(args.reviewGate, null, 2), '```');
  }
  return lines.join('\n');
}

export function parseMakePrStackPublishResult(raw: string): MakePrStackArtifactOutput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error('make-pr stack publisher must output JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('make-pr stack publisher output must be a JSON object');
  }
  const artifacts = (parsed as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts)) {
    throw new Error('make-pr stack publisher output must include artifacts array');
  }

  if (artifacts.length === 0) {
    throw new Error('make-pr stack publisher output must include at least one artifact');
  }
  const ids = new Set<string>();
  const records: MakePrStackArtifactOutput[] = [];
  for (let i = 0; i < artifacts.length; i += 1) {
    const artifact = artifacts[i];
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw new Error(`artifacts[${i}] must be an object`);
    }
    const record = artifact as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.length === 0) {
      throw new Error(`artifacts[${i}].id must be a non-empty string`);
    }
    if (ids.has(record.id)) {
      throw new Error(`artifacts[${i}].id duplicates artifact "${record.id}"`);
    }
    if (typeof record.url !== 'string' || record.url.length === 0) {
      throw new Error(`artifacts[${i}].url must be a non-empty string`);
    }
    const dependsOn = record.dependsOn === undefined ? undefined : record.dependsOn;
    if (dependsOn !== undefined && !Array.isArray(dependsOn)) {
      throw new Error(`artifacts[${i}].dependsOn must be an array`);
    }
    const normalizedDependsOn = dependsOn === undefined
      ? undefined
      : dependsOn.map((dependency) => {
        if (typeof dependency !== 'string' || dependency.length === 0) {
          throw new Error(`artifacts[${i}].dependsOn must contain non-empty artifact ids`);
        }
        return dependency;
      });
    ids.add(record.id);
    records.push({
      id: record.id,
      title: typeof record.title === 'string' ? record.title : undefined,
      url: record.url,
      providerId: typeof record.providerId === 'string' ? record.providerId : undefined,
      branch: typeof record.branch === 'string' ? record.branch : undefined,
      baseBranch: typeof record.baseBranch === 'string' ? record.baseBranch : undefined,
      dependsOn: normalizedDependsOn,
    });
  }

  for (let i = 0; i < records.length; i += 1) {
    const artifact = records[i];
    for (const dependency of artifact.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(`artifacts[${i}].dependsOn references unknown artifact "${dependency}"`);
      }
      if (dependency === artifact.id) {
        throw new Error(`artifacts[${i}].dependsOn must not reference itself`);
      }
    }
  }

  if ((records[0]?.dependsOn?.length ?? 0) > 0) {
    throw new Error('artifacts[0].dependsOn must be omitted or [] to start the review stack');
  }
  for (let i = 1; i < records.length; i += 1) {
    const expectedDependency = records[i - 1]?.id;
    const dependencies = records[i]?.dependsOn;
    if (dependencies?.length !== 1 || dependencies[0] !== expectedDependency) {
      throw new Error(`artifacts[${i}].dependsOn must be ["${expectedDependency}"] to keep the review stack linear`);
    }
  }

  return records;
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
  const cmd = resolveExecutableOnCurrentPath(spec.cmd) ?? spec.cmd;

  return new Promise<{ body: string; stdout: string; sessionId: string }>((resolve, reject) => {
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
