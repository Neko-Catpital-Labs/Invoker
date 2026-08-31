import { describe, expect, it } from 'vitest';

import {
  advanceVerifierWorkflow,
  canonicalVerifierFindingKey,
  compileVerificationRequirements,
  createVerifierWorkflow,
} from '../verification-contract.js';

describe('verifier workflow contract', () => {
  it('uses canonical lineage and finding identity as the idempotency key', () => {
    const left = canonicalVerifierFindingKey({
      repository: 'Neko-Catpital-Labs/Invoker',
      baseCommitSha: 'ABC123',
      sourceSessionId: 'codex/session-1',
      findingHash: 'FINDING-A',
    });
    const right = canonicalVerifierFindingKey({
      repository: ' neko-catpital-labs/invoker ',
      baseCommitSha: 'abc123',
      sourceSessionId: ' codex/session-1 ',
      findingHash: 'finding-a',
    });

    expect(left).toBe(right);
  });

  it('advances each workflow phase exactly once through the PR branch', () => {
    const discovered = createVerifierWorkflow({
      repository: 'Neko-Catpital-Labs/Invoker',
      baseCommitSha: 'abc123',
      sourceSessionId: 'claude/session-2',
      findingHash: 'finding-b',
      discoveredAt: '2026-08-31T10:00:00.000Z',
    });
    const validated = advanceVerifierWorkflow(discovered, {
      phase: 'validated',
      at: '2026-08-31T10:01:00.000Z',
    });
    const dispatched = advanceVerifierWorkflow(validated, {
      phase: 'dispatched',
      workflowId: 'wf-1',
      at: '2026-08-31T10:02:00.000Z',
    });
    const prOpened = advanceVerifierWorkflow(dispatched, {
      phase: 'pr_opened',
      pullRequestUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/1',
      at: '2026-08-31T10:03:00.000Z',
    });
    const graded = advanceVerifierWorkflow(prOpened, {
      phase: 'independently_graded',
      grade: 'accepted',
      graderId: 'codex-judge',
      at: '2026-08-31T10:04:00.000Z',
    });
    const terminal = advanceVerifierWorkflow(graded, {
      phase: 'terminal',
      outcome: 'pr_opened',
      at: '2026-08-31T10:05:00.000Z',
    });

    expect(terminal.phase).toBe('terminal');
    expect(terminal.history.map((entry) => entry.phase)).toEqual([
      'discovered',
      'validated',
      'dispatched',
      'pr_opened',
      'independently_graded',
      'terminal',
    ]);
    expect(advanceVerifierWorkflow(terminal, {
      phase: 'terminal',
      outcome: 'pr_opened',
      at: '2026-08-31T10:05:00.000Z',
    })).toBe(terminal);
  });

  it('supports no-finding terminalization and refuses skipped or repeated phases', () => {
    const discovered = createVerifierWorkflow({
      repository: 'Neko-Catpital-Labs/Invoker',
      baseCommitSha: 'abc123',
      sourceSessionId: 'cursor/session-3',
      findingHash: 'finding-c',
      discoveredAt: '2026-08-31T10:00:00.000Z',
    });

    expect(() => advanceVerifierWorkflow(discovered, {
      phase: 'dispatched',
      workflowId: 'wf-skipped-validation',
      at: '2026-08-31T10:01:00.000Z',
    })).toThrow(/cannot transition from discovered to dispatched/);

    const validated = advanceVerifierWorkflow(discovered, {
      phase: 'validated',
      at: '2026-08-31T10:01:00.000Z',
    });
    expect(() => advanceVerifierWorkflow(validated, {
      phase: 'validated',
      at: '2026-08-31T10:02:00.000Z',
    })).toThrow(/phase validated was already persisted/);

    const dispatched = advanceVerifierWorkflow(validated, {
      phase: 'dispatched',
      workflowId: 'wf-2',
      at: '2026-08-31T10:02:00.000Z',
    });
    const noFinding = advanceVerifierWorkflow(dispatched, {
      phase: 'no_finding',
      reason: 'No durable finding survived validation',
      at: '2026-08-31T10:03:00.000Z',
    });
    const graded = advanceVerifierWorkflow(noFinding, {
      phase: 'independently_graded',
      grade: 'accepted',
      graderId: 'claude-judge',
      at: '2026-08-31T10:04:00.000Z',
    });

    expect(advanceVerifierWorkflow(graded, {
      phase: 'terminal',
      outcome: 'no_finding',
      at: '2026-08-31T10:05:00.000Z',
    }).phase).toBe('terminal');
  });
});

describe('verification requirement compiler', () => {
  it('orders deterministic execution first and independent judgment last', () => {
    expect(compileVerificationRequirements([
      'bug_fix',
      'visual_ui',
      'external_effect',
      'deployment',
    ])).toEqual([
      'deterministic_command',
      'bug_repro_fail_pass',
      'opened_visual_proof',
      'external_effect_reconciliation',
      'deployed_version',
      'independent_judgment',
    ]);
  });

  it('deduplicates repeated change classes', () => {
    expect(compileVerificationRequirements(['bug_fix', 'bug_fix'])).toEqual([
      'deterministic_command',
      'bug_repro_fail_pass',
      'independent_judgment',
    ]);
  });
});
