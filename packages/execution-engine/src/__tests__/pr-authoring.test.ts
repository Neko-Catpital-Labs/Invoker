import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  buildCanonicalPrBody,
  buildMakePrStackPublishPrompt,
  parseMakePrStackPublishResult,
  resolveSkillPathViaAgent,
  spawnAgentPrAuthorViaRegistry,
  validateCanonicalPrBody,
  validateReviewStackPrBody,
} from '../pr-authoring.js';
import type { ExecutionAgent } from '../agent.js';

// ── Helpers ──────────────────────────────────────────────

function makeAgent(name: string, opts?: {
  bundledSkillRoot?: string;
  bundledSkills?: readonly string[];
}): ExecutionAgent {
  return {
    name,
    stdinMode: 'ignore',
    buildCommand: () => ({ cmd: name, args: [] }),
    buildResumeArgs: () => ({ cmd: name, args: [] }),
    ...(opts?.bundledSkillRoot !== undefined && { bundledSkillRoot: opts.bundledSkillRoot }),
    ...(opts?.bundledSkills !== undefined && { bundledSkills: opts.bundledSkills }),
  };
}

const tempDirs: string[] = [];
function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-authoring-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ── buildCanonicalPrBody ─────────────────────────────────

describe('buildCanonicalPrBody', () => {
  it('produces a valid canonical body with workflow summary only', () => {
    const body = buildCanonicalPrBody({
      title: 'Add feature X',
      workflowSummary: 'Implemented feature X for better UX.',
    });

    expect(body).toContain('## Summary');
    expect(body).toContain('Implemented feature X for better UX.');
    expect(body).toContain('## Test Plan');
    expect(body).toContain('Manual verification required');
    expect(body).toContain('## Revert Plan');

    const errors = validateCanonicalPrBody(body);
    expect(errors).toEqual([]);
  });

  it('uses workflowDescription from structured context when present', () => {
    const body = buildCanonicalPrBody({
      title: 'Refactor Y',
      workflowSummary: 'fallback summary',
      structuredContext: {
        workflowDescription: 'Structured description of refactoring Y.',
        tasks: [],
      },
    });

    expect(body).toContain('Structured description of refactoring Y.');
    expect(body).not.toContain('fallback summary');
  });

  it('includes completed verification commands in test plan', () => {
    const body = buildCanonicalPrBody({
      title: 'Add tests',
      workflowSummary: 'Added test coverage.',
      structuredContext: {
        tasks: [
          { taskId: 't1', description: 'Run unit tests', status: 'completed', command: 'pnpm test' },
          { taskId: 't2', description: 'Run lint', status: 'completed', command: 'pnpm lint' },
          { taskId: 't3', description: 'Skipped task', status: 'skipped', command: 'pnpm e2e' },
        ],
      },
    });

    expect(body).toContain('- [x] `pnpm test` — Run unit tests');
    expect(body).toContain('- [x] `pnpm lint` — Run lint');
    expect(body).not.toContain('pnpm e2e');
  });

  it('preserves visual proof markdown verbatim', () => {
    const visualProof = '## Visual Proof\n\n| Before | After |\n|--------|-------|\n| ![b](b.png) | ![a](a.png) |';
    const body = buildCanonicalPrBody({
      title: 'UI change',
      workflowSummary: 'Updated the UI.',
      structuredContext: {
        tasks: [],
        visualProofMarkdown: visualProof,
      },
    });

    expect(body).toContain(visualProof);
  });

  it('canonical body passes validation', () => {
    const body = buildCanonicalPrBody({
      title: 'Anything',
      workflowSummary: 'Any summary.',
      structuredContext: {
        tasks: [
          { taskId: 't1', description: 'build', status: 'completed', command: 'pnpm build' },
        ],
        visualProofMarkdown: '## Visual Proof\nscreenshots here',
      },
    });

    const errors = validateCanonicalPrBody(body);
    expect(errors).toEqual([]);
  });
});

// ── validateReviewStackPrBody ────────────────────────────

// Shape of the body PR #2170 actually shipped: canonical sections + an
// Architecture block, but none of the review-compression sections. It passes
// the canonical validator yet must be rejected for an Invoker review stack.
const PR_2170_COMMIT_MESSAGE_BODY = [
  '## Summary',
  '',
  'Cut over recovery ownership to the explicit worker.',
  '',
  '## Architecture',
  '',
  '### Before',
  '```mermaid',
  'graph TD',
  '  A["hidden hook"]',
  '```',
  '',
  '### After',
  '```mermaid',
  'graph TD',
  '  A["worker autofix"]',
  '```',
  '',
  '## Test Plan',
  '',
  '- [x] `pnpm test`',
  '',
  '## Revert Plan',
  '',
  '- Safe to revert? Yes',
].join('\n');

// Canonical shape: review-compression fields live in a collapsed Review
// metadata block inside ## Summary; Non-goals/Test Plan/Revert Plan are
// top-level. Mirrors scripts/validate-pr-body.mjs.
const COMPLIANT_REVIEW_STACK_BODY = [
  '## Summary',
  '',
  'Plain explanation of the slice.',
  '',
  '<details>',
  '<summary>Review metadata</summary>',
  '',
  'Review Claim: Approve the one thing this slice does.',
  'Review Lane: cleanup',
  'Review Unit: scalar',
  'Safety Invariant: Why this slice is safe to review locally.',
  'Slice Rationale: Why the work is split here.',
  '',
  '</details>',
  '',
  '## Non-goals',
  '',
  '- Does not change behavior.',
  '',
  '## Test Plan',
  '',
  '- [x] `pnpm test`',
  '',
  '## Revert Plan',
  '',
  '- Safe to revert? Yes',
].join('\n');

describe('validateReviewStackPrBody', () => {
  it('rejects a commit-message body that lacks the review metadata block + Non-goals (PR #2170)', () => {
    const errors = validateReviewStackPrBody(PR_2170_COMMIT_MESSAGE_BODY);
    expect(errors).toContain('Missing required section: ## Non-goals');
    expect(errors).toContain(
      '## Summary must include a collapsed <details> block with <summary>Review metadata</summary>.',
    );
    // The same body passes the looser canonical validator — proving why #2170
    // shipped: the Invoker stack path never applied the stricter schema.
    expect(validateCanonicalPrBody(PR_2170_COMMIT_MESSAGE_BODY)).toEqual([]);
  });

  it('accepts a body carrying the full review-stack schema', () => {
    expect(validateReviewStackPrBody(COMPLIANT_REVIEW_STACK_BODY)).toEqual([]);
  });

  it('rejects visible top-level metadata sections', () => {
    const visible = COMPLIANT_REVIEW_STACK_BODY + '\n\n## Review Claim\n\nshould be in metadata';
    const errors = validateReviewStackPrBody(visible);
    expect(errors.some((e) => e.includes('## Review Claim belongs in the collapsed Review metadata block'))).toBe(true);
  });

  it('rejects a metadata block missing a required field', () => {
    const missingUnit = COMPLIANT_REVIEW_STACK_BODY.replace('Review Unit: scalar\n', '');
    const errors = validateReviewStackPrBody(missingUnit);
    expect(errors).toContain('Review metadata is missing required field: Review Unit:');
  });

  it('rejects an empty body with a schema hint', () => {
    const errors = validateReviewStackPrBody('');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Review metadata block');
  });

  it('does not count schema headings that appear inside fenced code blocks', () => {
    const fenced = COMPLIANT_REVIEW_STACK_BODY.replace(
      '## Non-goals\n',
      '```md\n## Non-goals\n```\n',
    );
    const errors = validateReviewStackPrBody(fenced);
    expect(errors).toContain('Missing required section: ## Non-goals');
  });

  it('requires real Markdown headings, not section names mentioned inline', () => {
    // Mentions "## Non-goals" only inside prose, not as a heading line.
    const inlineOnly = COMPLIANT_REVIEW_STACK_BODY.replace(
      '## Non-goals\n',
      'This PR has no `## Non-goals` to speak of.\n',
    );
    const errors = validateReviewStackPrBody(inlineOnly);
    expect(errors).toContain('Missing required section: ## Non-goals');
  });
});

// ── make-pr stack publish prompt + parsing ───────────────

describe('make-pr stack publish body contract', () => {
  it('prompt requires an explicit schema-compliant body per artifact', () => {
    const prompt = buildMakePrStackPublishPrompt({
      skillPath: '/skills/invoker-make-pr',
      title: 'My stack',
      baseBranch: 'master',
      featureBranch: 'feature',
      workflowSummary: 'summary',
      cwd: '/repo',
    });
    expect(prompt).toContain('"body":"string"');
    expect(prompt).toContain('artifact.body MUST be the exact PR body');
    expect(prompt).toContain('Review metadata');
    expect(prompt).toContain('Review Unit');
    expect(prompt).toContain('Do NOT let Mergify default the PR body');
  });

  it('parses the body field for each artifact', () => {
    const raw = JSON.stringify({
      artifacts: [
        { id: 'a', url: 'https://x/1', body: COMPLIANT_REVIEW_STACK_BODY },
        { id: 'b', url: 'https://x/2', dependsOn: ['a'], body: COMPLIANT_REVIEW_STACK_BODY },
      ],
    });
    const parsed = parseMakePrStackPublishResult(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.body).toBe(COMPLIANT_REVIEW_STACK_BODY);
    expect(parsed[1]?.body).toBe(COMPLIANT_REVIEW_STACK_BODY);
  });

  it('leaves body undefined when the agent omits it (caller then rejects it)', () => {
    const raw = JSON.stringify({ artifacts: [{ id: 'a', url: 'https://x/1' }] });
    const parsed = parseMakePrStackPublishResult(raw);
    expect(parsed[0]?.body).toBeUndefined();
    // The caller validates this empty body and falls through to the next agent.
    expect(validateReviewStackPrBody(parsed[0]?.body ?? '').length).toBeGreaterThan(0);
  });
});

// ── resolveSkillPathViaAgent ─────────────────────────────

describe('resolveSkillPathViaAgent', () => {
  it('resolves skill from agent bundledSkillRoot when SKILL.md exists', () => {
    const tmpDir = createTempDir();
    const skillDir = join(tmpDir, 'invoker-make-pr');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# make-pr\n');

    const agent = makeAgent('custom-agent', { bundledSkillRoot: tmpDir });
    const result = resolveSkillPathViaAgent(agent, 'make-pr');
    expect(result).toBe(skillDir);
  });

  it('returns null when bundledSkillRoot exists but SKILL.md is missing', () => {
    const tmpDir = createTempDir();
    mkdirSync(join(tmpDir, 'invoker-make-pr'), { recursive: true });
    // No SKILL.md

    const agent = makeAgent('custom-agent', { bundledSkillRoot: tmpDir });
    const result = resolveSkillPathViaAgent(agent, 'make-pr');
    expect(result).toBeNull();
  });

  it('falls back to name-based resolution for agents without bundledSkillRoot', () => {
    const agent = makeAgent('unknown-agent');
    const result = resolveSkillPathViaAgent(agent, 'make-pr');
    // unknown-agent is not claude or codex, so name-based resolution returns null
    expect(result).toBeNull();
  });

  it('prefers bundledSkillRoot over name-based resolution', () => {
    const tmpDir = createTempDir();
    const skillDir = join(tmpDir, 'invoker-make-pr');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# make-pr\n');

    // Agent named 'claude' but with custom bundledSkillRoot
    const agent = makeAgent('claude', { bundledSkillRoot: tmpDir });
    const result = resolveSkillPathViaAgent(agent, 'make-pr');
    expect(result).toBe(skillDir);
  });
});

// ── spawnAgentPrAuthorViaRegistry ───────────────────────

describe('spawnAgentPrAuthorViaRegistry', () => {
  it('times out and rejects when the PR-authoring agent never exits', async () => {
    const tmpDir = createTempDir();
    const previousTimeout = process.env.INVOKER_PR_AUTHORING_TIMEOUT_MS;
    process.env.INVOKER_PR_AUTHORING_TIMEOUT_MS = '25';

    const agent: ExecutionAgent = {
      name: 'codex',
      stdinMode: 'ignore',
      buildCommand: () => ({
        cmd: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        sessionId: 'hung-pr-author',
      }),
      buildResumeArgs: () => ({ cmd: process.execPath, args: ['-e', ''] }),
    };

    try {
      await expect(
        spawnAgentPrAuthorViaRegistry('publish stack', tmpDir, agent),
      ).rejects.toThrow(/codex PR authoring exceeded timeout \(25ms\)/);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.INVOKER_PR_AUTHORING_TIMEOUT_MS;
      } else {
        process.env.INVOKER_PR_AUTHORING_TIMEOUT_MS = previousTimeout;
      }
    }
  });
});
