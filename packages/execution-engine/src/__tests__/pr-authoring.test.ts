import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  buildCanonicalPrBody,
  resolveSkillPathViaAgent,
  spawnAgentPrAuthorViaRegistry,
  validateCanonicalPrBody,
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
