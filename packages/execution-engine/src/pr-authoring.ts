import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import type { ExecutionAgent } from './agent.js';
import type { SessionDriver } from './session-driver.js';
import { cleanElectronEnv, killProcessGroup, resolveExecutableOnCurrentPath, SIGKILL_TIMEOUT_MS } from './process-utils.js';

export interface MakePrStackArtifactOutput {
  readonly id: string;
  readonly title?: string;
  readonly url: string;
  readonly providerId?: string;
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly dependsOn?: readonly string[];
  /** Published PR body. Validated against the make-pr review-stack schema. */
  readonly body?: string;
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
// Canonical review-stack schema, mirrored structurally from
// scripts/validate-pr-body.mjs — the authoritative validator the make-pr skill
// runs. The review-compression fields live INSIDE a collapsed
// <details>Review metadata</details> block in ## Summary, not as visible
// top-level sections, so a bare commit-message body (e.g. PR #2170) is rejected.
const REVIEW_STACK_REQUIRED_SECTIONS = [
  '## Summary',
  '## Non-goals',
  '## Test Plan',
  '## Revert Plan',
] as const;
const REVIEW_STACK_VISIBLE_METADATA_SECTIONS = [
  '## Review Claim',
  '## Review Lane',
  '## Review Unit',
  '## Safety Invariant',
  '## Slice Rationale',
] as const;
const REVIEW_STACK_METADATA_LABELS = [
  'Review Claim',
  'Review Lane',
  'Review Unit',
  'Safety Invariant',
  'Slice Rationale',
] as const;
const DISCOURAGED_HEADINGS = ['## Testing', '## Notes'] as const;
const DEFAULT_MAX_INLINE_PROMPT_BYTES = 64 * 1024;
const DEFAULT_PR_AUTHORING_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_INLINE_PROMPT_BYTES = (() => {
  const raw = process.env.INVOKER_MAX_INLINE_AGENT_PROMPT_BYTES;
  if (!raw) return DEFAULT_MAX_INLINE_PROMPT_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_INLINE_PROMPT_BYTES;
})();

function getPrAuthoringTimeoutMs(): number {
  const raw = process.env.INVOKER_PR_AUTHORING_TIMEOUT_MS?.trim();
  if (raw === '0') return 0;
  if (!raw) return DEFAULT_PR_AUTHORING_TIMEOUT_MS;
  // Validate the whole string: Number.parseInt would silently accept a numeric
  // prefix, turning "20m" into 20ms and failing authoring almost immediately.
  if (!/^(0|[1-9]\d*)$/.test(raw)) return DEFAULT_PR_AUTHORING_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return DEFAULT_PR_AUTHORING_TIMEOUT_MS;
  return parsed;
}

/** True when `heading` appears as a real Markdown heading line, not as prose/code text. */
function hasMarkdownHeading(body: string, heading: string): boolean {
  const expected = heading.trim().toLowerCase();
  return body.split(/\r?\n/).some((line) => line.trim().toLowerCase() === expected);
}

function validateBodyAgainstSections(
  body: string,
  requiredSections: readonly string[],
  emptyMessage: string,
): string[] {
  const errors: string[] = [];
  const trimmed = body.trim();

  if (!trimmed) {
    return [emptyMessage];
  }

  for (const heading of requiredSections) {
    if (!hasMarkdownHeading(trimmed, heading)) {
      errors.push(`Missing required section: ${heading}`);
    }
  }

  for (const heading of DISCOURAGED_HEADINGS) {
    if (hasMarkdownHeading(trimmed, heading)) {
      errors.push(
        `Unsupported section: ${heading}. Do not use the lightweight PR format; use ## Test Plan and ## Revert Plan instead.`,
      );
    }
  }

  if (hasMarkdownHeading(trimmed, '## Architecture')) {
    for (const subsection of ['### Before', '### After']) {
      if (!hasMarkdownHeading(trimmed, subsection)) {
        errors.push(`Architecture section is missing required subsection: ${subsection}`);
      }
    }
  }

  return errors;
}

export function validateCanonicalPrBody(body: string): string[] {
  return validateBodyAgainstSections(
    body,
    REQUIRED_SECTIONS,
    'PR body is empty. Use the canonical schema: ## Summary, ## Test Plan, ## Revert Plan, plus optional ## Architecture.',
  );
}

/** Collect the lines under a `## Heading` until the next `## ` heading. */
function getMarkdownSection(body: string, heading: string): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return '';
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** Extract the collapsed `<details><summary>Review metadata</summary>` block from ## Summary. */
function getReviewMetadataBlock(body: string): { body: string; openAttributes: string } | null {
  const summary = getMarkdownSection(body, '## Summary');
  const match = summary.match(
    /<details\b([^>]*)>\s*<summary>\s*Review metadata\s*<\/summary>([\s\S]*?)<\/details>/i,
  );
  if (!match) return null;
  return { body: match[2].trim(), openAttributes: match[1] };
}

/** True when the metadata block carries a non-empty `Label:` field. */
function hasMetadataLabel(metadata: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\n)\\s*${escaped}:\\s*\\S`, 'i').test(metadata);
}

/**
 * Validate a published Invoker review-stack PR body. This mirrors the structural
 * checks in scripts/validate-pr-body.mjs (the authoritative validator the make-pr
 * skill is told to run): required top-level sections, no visible metadata
 * sections, and a collapsed Review metadata block carrying every required field.
 * A mergify-default commit-message body cannot pass. The deeper review-unit and
 * mermaid rules stay in validate-pr-body.mjs; this is the in-process backstop.
 */
export function validateReviewStackPrBody(body: string): string[] {
  const trimmed = body.trim();
  if (!trimmed) {
    return [
      'PR body is empty. Use the canonical review-stack schema: ## Summary with a collapsed '
        + 'Review metadata block, ## Non-goals, ## Test Plan, and ## Revert Plan.',
    ];
  }

  const errors: string[] = [];
  for (const heading of REVIEW_STACK_REQUIRED_SECTIONS) {
    if (!hasMarkdownHeading(trimmed, heading)) {
      errors.push(`Missing required section: ${heading}`);
    }
  }
  for (const heading of REVIEW_STACK_VISIBLE_METADATA_SECTIONS) {
    if (hasMarkdownHeading(trimmed, heading)) {
      errors.push(
        `${heading} belongs in the collapsed Review metadata block inside ## Summary, `
          + 'not as a visible top-level section.',
      );
    }
  }
  for (const heading of DISCOURAGED_HEADINGS) {
    if (hasMarkdownHeading(trimmed, heading)) {
      errors.push(
        `Unsupported section: ${heading}. Do not use the lightweight PR format; `
          + 'use the canonical review-compression schema instead.',
      );
    }
  }
  if (hasMarkdownHeading(trimmed, '## Architecture')) {
    for (const subsection of ['### Before', '### After']) {
      if (!hasMarkdownHeading(trimmed, subsection)) {
        errors.push(`Architecture section is missing required subsection: ${subsection}`);
      }
    }
  }

  const metadata = getReviewMetadataBlock(trimmed);
  if (!metadata) {
    errors.push('## Summary must include a collapsed <details> block with <summary>Review metadata</summary>.');
  } else {
    if (/\bopen\b/i.test(metadata.openAttributes)) {
      errors.push('Review metadata details must be collapsed by default; remove the open attribute.');
    }
    for (const label of REVIEW_STACK_METADATA_LABELS) {
      if (!hasMetadataLabel(metadata.body, label)) {
        errors.push(`Review metadata is missing required field: ${label}:`);
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
  const httpsMatch = /^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?\/?$/i.exec(trimmed);
  const sshMatch = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/.]+)(?:\.git)?\/?$/i.exec(trimmed);
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
    '{"artifacts":[{"id":"string","title":"string","url":"string","providerId":"string","branch":"string","baseBranch":"string","dependsOn":["string"],"body":"string"}]}',
    '- artifacts are already listed in stack order.',
    '- artifacts[0].dependsOn must be omitted or [].',
    '- For every i > 0, artifacts[i].dependsOn must be exactly [artifacts[i - 1].id].',
    '- Do not emit branches, merges, skipped predecessors, or multiple dependencies.',
    '- Do not add fixed PR-count fields.',
    '- Do not add Mergify-specific fields to the JSON.',
    '- Each artifact.body MUST be the exact PR body you published for that PR.',
    '- Each body MUST follow the canonical review-stack schema and pass '
      + '`node scripts/validate-pr-body.mjs`. Required: ## Summary containing a collapsed '
      + '<details><summary>Review metadata</summary> block with Review Claim, Review Lane, '
      + 'Review Unit, Safety Invariant, and Slice Rationale fields; plus top-level ## Non-goals, '
      + '## Test Plan, and ## Revert Plan. Do not use visible ## Review Claim / ## Review Lane sections.',
    '- Do NOT let Mergify default the PR body to the commit message; author the body explicitly.',
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
    if (typeof record.id !== 'string' || record.id.trim().length === 0) {
      throw new Error(`artifacts[${i}].id must be a non-empty string`);
    }
    const id = record.id.trim();
    if (ids.has(id)) {
      throw new Error(`artifacts[${i}].id duplicates artifact "${id}"`);
    }
    if (typeof record.url !== 'string' || record.url.trim().length === 0) {
      throw new Error(`artifacts[${i}].url must be a non-empty string`);
    }
    const url = record.url.trim();
    const dependsOn = record.dependsOn === undefined ? undefined : record.dependsOn;
    if (dependsOn !== undefined && !Array.isArray(dependsOn)) {
      throw new Error(`artifacts[${i}].dependsOn must be an array`);
    }
    const normalizedDependsOn = dependsOn === undefined
      ? undefined
      : dependsOn.map((dependency) => {
        if (typeof dependency !== 'string' || dependency.trim().length === 0) {
          throw new Error(`artifacts[${i}].dependsOn must contain non-empty artifact ids`);
        }
        return dependency.trim();
      });
    ids.add(id);
    records.push({
      id,
      title: typeof record.title === 'string' ? record.title : undefined,
      url,
      providerId: typeof record.providerId === 'string' ? record.providerId : undefined,
      branch: typeof record.branch === 'string' ? record.branch : undefined,
      baseBranch: typeof record.baseBranch === 'string' ? record.baseBranch : undefined,
      dependsOn: normalizedDependsOn,
      body: typeof record.body === 'string' ? record.body : undefined,
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
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeoutError: Error | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = getPrAuthoringTimeoutMs();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      promptTransport.cleanup();
      fn();
    };

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (settled || timedOut) return;
        timedOut = true;
        timeoutError = new Error(
          `${agent.name} PR authoring exceeded timeout (${timeoutMs}ms) in ${cwd}. ` +
          'Set INVOKER_PR_AUTHORING_TIMEOUT_MS to adjust (0 = unbounded).',
        );
        if (timeout) clearTimeout(timeout);
        killProcessGroup(child, 'SIGTERM');
        // Reject only after the process is forcibly killed, so the caller cannot
        // launch the next make-pr agent while this one may still be mutating PRs.
        forceKillTimeout = setTimeout(() => {
          killProcessGroup(child, 'SIGKILL');
          finish(() => reject(timeoutError!));
        }, SIGKILL_TIMEOUT_MS);
        forceKillTimeout.unref?.();
      }, timeoutMs);
      timeout.unref?.();
    }

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (settled) return;
      // The timed-out process exited on SIGTERM before the SIGKILL timer fired;
      // it is already gone, so settle with the timeout error now.
      if (timedOut) {
        finish(() => reject(timeoutError!));
        return;
      }
      finish(() => {
        const realId = driver?.extractSessionId?.(stdout);
        const effectiveSessionId = realId ?? sessionId;
        const displayStdout = driver ? driver.processOutput(effectiveSessionId, stdout) : stdout;
        if (code === 0) {
          const body = extractAssistantBody(driver, effectiveSessionId, displayStdout);
          resolve({ body, stdout: displayStdout, sessionId: effectiveSessionId });
          return;
        }
        reject(new Error(`${agent.name} PR authoring exited with code ${code}: ${stderr.trim()}`));
      });
    });
    child.on('error', (err) => {
      finish(() => reject(err));
    });
  });
}
