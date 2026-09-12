import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  buildCanonicalPrBody,
  buildMakePrStackPublishPrompt,
  classifyAgentTurnWork,
  describeEmptyAgentTurn,
  parseMakePrStackPublishResult,
  resolveSkillPathViaAgent,
  spawnAgentPrAuthorViaRegistry,
  validateCanonicalPrBody,
  validateReviewStackPrBody,
} from '../pr-authoring.js';
import type { ExecutionAgent } from '../agent.js';
import { CodexSessionDriver } from '../codex-session-driver.js';

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

  it('renders worker action pipeline rows in chronological order', () => {
    const body = buildCanonicalPrBody({
      title: 'Refresh PR summary',
      workflowSummary: 'Show Invoker pipeline work.',
      structuredContext: {
        tasks: [],
        workerActions: [
          {
            workerKind: 'ci-failure',
            actionType: 'fix-ci-failure',
            status: 'completed',
            taskId: 'wf-1/repair',
            summary: 'Submitted CI repair.',
            createdAt: '2026-01-01T00:02:00.000Z',
          },
          {
            workerKind: 'autofix',
            actionType: 'auto-fix',
            status: 'skipped',
            taskId: 'wf-1/build',
            reason: 'retry-budget-exhausted',
            createdAt: '2026-01-01T00:01:00.000Z',
          },
        ],
      },
    });

    expect(body).toContain('## Pipeline');
    const first = body.indexOf('| 2026-01-01T00:01:00.000Z | autofix | auto-fix | skipped | wf-1/build | (retry-budget-exhausted) |');
    const second = body.indexOf('| 2026-01-01T00:02:00.000Z | ci-failure | fix-ci-failure | completed | wf-1/repair | Submitted CI repair. |');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
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

// Canonical shape: review-compression fields are visible top-level sections.
// Mirrors scripts/validate-pr-body.mjs.
const COMPLIANT_REVIEW_STACK_BODY = [
  '## Summary',
  '',
  'Plain explanation of the slice.',
  '',
  '## Review Claim',
  '',
  'Approve the one thing this slice does.',
  '',
  '## Review Lane',
  '',
  'cleanup',
  '',
  '## Review Unit',
  '',
  'scalar',
  '',
  '## Safety Invariant',
  '',
  'Why this slice is safe to review locally.',
  '',
  '## Slice Rationale',
  '',
  'Why the work is split here.',
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

// Legacy shape rejected since the schema flip: metadata hidden in a collapsed
// <details> block inside ## Summary.
const LEGACY_DETAILS_REVIEW_STACK_BODY = [
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
  it('rejects a commit-message body that lacks the metadata sections + Non-goals (PR #2170)', () => {
    const errors = validateReviewStackPrBody(PR_2170_COMMIT_MESSAGE_BODY);
    expect(errors).toContain('Missing required section: ## Non-goals');
    expect(errors).toContain('Missing required section: ## Review Claim');
    // The same body passes the looser canonical validator — proving why #2170
    // shipped: the Invoker stack path never applied the stricter schema.
    expect(validateCanonicalPrBody(PR_2170_COMMIT_MESSAGE_BODY)).toEqual([]);
  });

  it('accepts a body carrying the full review-stack schema', () => {
    expect(validateReviewStackPrBody(COMPLIANT_REVIEW_STACK_BODY)).toEqual([]);
  });

  it('rejects metadata hidden in a legacy <details> block', () => {
    const errors = validateReviewStackPrBody(LEGACY_DETAILS_REVIEW_STACK_BODY);
    expect(errors.some((e) => e.includes('Do not hide review metadata in <details>'))).toBe(true);
    expect(errors).toContain('Missing required section: ## Review Claim');
  });

  it('rejects a body missing one metadata section', () => {
    const missingUnit = COMPLIANT_REVIEW_STACK_BODY.replace('## Review Unit\n\nscalar\n\n', '');
    const errors = validateReviewStackPrBody(missingUnit);
    expect(errors).toContain('Missing required section: ## Review Unit');
  });

  it('rejects a metadata section with an empty body', () => {
    const emptyClaim = COMPLIANT_REVIEW_STACK_BODY.replace(
      'Approve the one thing this slice does.',
      '',
    );
    const errors = validateReviewStackPrBody(emptyClaim);
    expect(errors).toContain('Missing required section: ## Review Claim');
  });

  it('rejects an empty body with a schema hint', () => {
    const errors = validateReviewStackPrBody('');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('## Review Claim');
  });

  it('does not count schema headings that appear inside fenced code blocks', () => {
    const fenced = COMPLIANT_REVIEW_STACK_BODY.replace(
      '## Non-goals\n',
      '```md\n## Non-goals\n```\n',
    );
    const errors = validateReviewStackPrBody(fenced);
    expect(errors).toContain('Missing required section: ## Non-goals');
  });

  it('does not count a four-space-indented heading (Markdown code) as a real section', () => {
    const indented = COMPLIANT_REVIEW_STACK_BODY.replace('## Non-goals\n', '    ## Non-goals\n');
    const errors = validateReviewStackPrBody(indented);
    expect(errors).toContain('Missing required section: ## Non-goals');
  });

  it('does not count metadata sections that only appear inside a code fence', () => {
    const fencedMeta = COMPLIANT_REVIEW_STACK_BODY.replace(
      '## Review Claim\n',
      '```md\n## Review Claim\n```\n',
    );
    const errors = validateReviewStackPrBody(fencedMeta);
    expect(errors).toContain('Missing required section: ## Review Claim');
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
    expect(prompt).toContain('Never hide review metadata');
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

  it('parses JSON wrapped in a ```json fenced code block despite the no-fences instruction', () => {
    const payload = JSON.stringify({ artifacts: [{ id: 'a', url: 'https://x/1' }] });
    const raw = '```json\n' + payload + '\n```';
    const parsed = parseMakePrStackPublishResult(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe('a');
  });

  it('parses JSON wrapped in a bare ``` fenced code block', () => {
    const payload = JSON.stringify({ artifacts: [{ id: 'a', url: 'https://x/1' }] });
    const raw = '```\n' + payload + '\n```';
    const parsed = parseMakePrStackPublishResult(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe('a');
  });

  it('extracts a JSON object surrounded by commentary the agent added despite instructions', () => {
    const payload = JSON.stringify({ artifacts: [{ id: 'a', url: 'https://x/1' }] });
    const raw = `Here is the published review stack:\n${payload}\nLet me know if you need anything else.`;
    const parsed = parseMakePrStackPublishResult(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe('a');
  });

  it('extracts balanced JSON when surrounding commentary and quoted strings contain braces', () => {
    const title = 'Keep } inside an escaped "quote" and { inside the string';
    const payload = JSON.stringify({
      artifacts: [{ id: 'a', url: 'https://x/1', title }],
    });
    const raw = `Preparing {draft} output.\n${payload}\nFinished with } commentary.`;
    const parsed = parseMakePrStackPublishResult(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.title).toBe(title);
  });

  it('does not let a valid-JSON decoy in leading commentary shadow the real artifacts payload', () => {
    const payload = JSON.stringify({ artifacts: [{ id: 'a', url: 'https://x/1' }] });
    // "{}" is itself valid, parseable JSON -- a naive first-match scanner
    // would stop here and never reach the real payload below it.
    const raw = `Status: {}\nHere is the published review stack:\n${payload}`;
    const parsed = parseMakePrStackPublishResult(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe('a');
  });

  it('extracts nested artifact JSON from an invalid enclosing brace span', () => {
    const payload = JSON.stringify({ artifacts: [{ id: 'a', url: 'https://x/1' }] });
    const raw = `Note: {payload follows: ${payload}}`;
    const parsed = parseMakePrStackPublishResult(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe('a');
  });

  it('still throws "must output JSON" for genuinely non-JSON output', () => {
    expect(() => parseMakePrStackPublishResult('I could not publish the PR stack.')).toThrow(
      'make-pr stack publisher must output JSON',
    );
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

// ── empty-turn detection ────────────────────────────────
//
// Captured verbatim from the merge-gate publisher session that failed this
// workflow twice (~72 min apart): codex emitted a benign skills warning, then
// completed the turn with zero token usage and no agent_message, and exited 0.
// Its own rollout log recorded `last_agent_message: null`, and its only user
// items were codex's own boilerplate (`<recommended_plugins>`, AGENTS.md,
// `<environment_context>`) -- the publish prompt was never delivered, so the
// model was never asked to publish anything.
const CODEX_EMPTY_TURN_JSONL = [
  '{"type":"thread.started","thread_id":"01a093b2-aac5-77b0-a62e-37ba0ecbb26d"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill'
    + ' descriptions were shortened to fit the skills context budget. Codex can still'
    + ' see every skill, but some descriptions are shorter. Disable unused skills or'
    + ' plugins to leave more room for the rest."}}',
  '{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,'
    + '"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}}',
].join('\n');

describe('agent turn that produced no assistant message', () => {
  function makeEmptyTurnAgent(jsonl: string): ExecutionAgent {
    return {
      name: 'codex',
      stdinMode: 'ignore',
      buildCommand: () => ({
        cmd: process.execPath,
        args: ['-e', `process.stdout.write(${JSON.stringify(jsonl)})`],
        sessionId: 'empty-turn-publisher',
      }),
      buildResumeArgs: () => ({ cmd: process.execPath, args: ['-e', ''] }),
    };
  }

  it('rejects instead of resolving an empty body when codex exits 0 with no agent message', async () => {
    const tmpDir = createTempDir();
    const dbDir = createTempDir();
    const previousDbDir = process.env.INVOKER_DB_DIR;
    process.env.INVOKER_DB_DIR = dbDir;
    try {
      await expect(
        spawnAgentPrAuthorViaRegistry(
          'publish stack',
          tmpDir,
          makeEmptyTurnAgent(CODEX_EMPTY_TURN_JSONL),
          new CodexSessionDriver(),
        ),
      ).rejects.toThrow(/produced no assistant message/i);
    } finally {
      if (previousDbDir === undefined) delete process.env.INVOKER_DB_DIR;
      else process.env.INVOKER_DB_DIR = previousDbDir;
    }
  });

  it("surfaces the agent's own error text so the operator can tell why the turn was empty", async () => {
    const tmpDir = createTempDir();
    const dbDir = createTempDir();
    const previousDbDir = process.env.INVOKER_DB_DIR;
    process.env.INVOKER_DB_DIR = dbDir;
    try {
      await expect(
        spawnAgentPrAuthorViaRegistry(
          'publish stack',
          tmpDir,
          makeEmptyTurnAgent(CODEX_EMPTY_TURN_JSONL),
          new CodexSessionDriver(),
        ),
      ).rejects.toThrow(/skills context budget/);
    } finally {
      if (previousDbDir === undefined) delete process.env.INVOKER_DB_DIR;
      else process.env.INVOKER_DB_DIR = previousDbDir;
    }
  });

  it('classifies the captured zero-token turn as provably no-work', () => {
    expect(classifyAgentTurnWork(CODEX_EMPTY_TURN_JSONL).verdict).toBe('no-work');
  });

  it('refuses to call a token-burning turn no-work, so it is never retried', () => {
    const raw = [
      '{"type":"turn.started"}',
      '{"type":"turn.completed","usage":{"input_tokens":1200,"output_tokens":0}}',
    ].join('\n');
    expect(classifyAgentTurnWork(raw).verdict).toBe('did-work');
  });

  it('refuses to call a turn with a non-error item no-work, so it is never retried', () => {
    const raw = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"gh pr create"}}',
      '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}',
    ].join('\n');
    expect(classifyAgentTurnWork(raw).verdict).toBe('did-work');
  });

  it('reports unknown, not no-work, when a JSONL line cannot be read', () => {
    const raw = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i1","type":"error",',
      '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}',
    ].join('\n');
    const result = classifyAgentTurnWork(raw);
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toMatch(/unreadable JSONL/);
  });

  it('reports unknown, not no-work, when the transcript has no usage at all', () => {
    expect(classifyAgentTurnWork('some plain agent chatter').verdict).toBe('unknown');
  });

  it('never tells the operator the agent exited non-zero when it exited 0', () => {
    const described = describeEmptyAgentTurn('', 'Reading additional input from stdin...');
    expect(described).not.toMatch(/exited non-zero/);
  });

  it('reports an empty publisher body as missing output, not as malformed JSON', () => {
    expect(() => parseMakePrStackPublishResult('   ')).toThrow(/produced no output/i);
  });

  it('still reports genuinely non-JSON output as a JSON format failure', () => {
    expect(() => parseMakePrStackPublishResult('I could not publish the PR stack.')).toThrow(
      'make-pr stack publisher must output JSON',
    );
  });
});
