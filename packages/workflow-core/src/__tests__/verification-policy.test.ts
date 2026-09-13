import { describe, expect, it } from 'vitest';

import type {
  IndependentJudgmentReceipt,
  VerificationReceipt,
} from '@invoker/contracts';

import { evaluateAutomaticVerificationReadiness } from '../verification-policy.js';

const commitSha = 'abc123';

function deterministicReceipt(overrides: Partial<VerificationReceipt> = {}): VerificationReceipt {
  return {
    id: 'command-1',
    kind: 'deterministic_command',
    commitSha,
    recordedAt: '2026-08-31T10:00:00.000Z',
    actor: { id: 'builder-1', role: 'builder' },
    status: 'passed',
    command: 'pnpm test',
    exitCode: 0,
    output: 'Tests passed',
    ...overrides,
  } as VerificationReceipt;
}

function judgmentReceipt(
  overrides: Partial<IndependentJudgmentReceipt> = {},
): IndependentJudgmentReceipt {
  return {
    id: 'judgment-1',
    kind: 'independent_judgment',
    commitSha,
    recordedAt: '2026-08-31T10:05:00.000Z',
    actor: { id: 'judge-1', role: 'judge' },
    status: 'passed',
    verdict: 'approve',
    rationale: 'Evidence matches the change class',
    ...overrides,
  };
}

function bugReproReceipt(overrides: Partial<VerificationReceipt> = {}): VerificationReceipt {
  return {
    id: 'repro-1',
    kind: 'bug_repro_fail_pass',
    commitSha,
    recordedAt: '2026-08-31T10:02:00.000Z',
    actor: { id: 'builder-1', role: 'builder' },
    status: 'passed',
    before: { command: 'pnpm test -- bug', exitCode: 1, output: '1 failed' },
    after: { command: 'pnpm test -- bug', exitCode: 0, output: '1 passed' },
    ...overrides,
  } as VerificationReceipt;
}

function decision(receipts: VerificationReceipt[]) {
  return evaluateAutomaticVerificationReadiness({
    target: 'review_ready',
    targetCommitSha: commitSha,
    builderActorId: 'builder-1',
    changeClasses: ['bug_fix'],
    receipts,
  });
}

describe('evaluateAutomaticVerificationReadiness', () => {
  it('accepts commit-bound evidence with an independent approving judge', () => {
    expect(decision([
      deterministicReceipt(),
      bugReproReceipt(),
      judgmentReceipt(),
    ])).toEqual({
      ready: true,
      target: 'review_ready',
      targetCommitSha: commitSha,
      requirements: [
        'deterministic_command',
        'bug_repro_fail_pass',
        'independent_judgment',
      ],
      refusals: [],
    });
  });

  it('refuses missing required evidence', () => {
    expect(decision([deterministicReceipt(), judgmentReceipt()])).toMatchObject({
      ready: false,
      refusals: [{
        code: 'missing_receipt',
        requirement: 'bug_repro_fail_pass',
      }],
    });
  });

  it('refuses receipts whose recorded result or payload failed', () => {
    const result = decision([
      deterministicReceipt({ exitCode: 1 }),
      bugReproReceipt({ status: 'failed' }),
      judgmentReceipt(),
    ]);

    expect(result.ready).toBe(false);
    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'failed_receipt', receiptId: 'command-1' }),
      expect.objectContaining({ code: 'failed_receipt', receiptId: 'repro-1' }),
    ]));
  });

  it('refuses receipts bound to another commit', () => {
    const result = decision([
      deterministicReceipt({ commitSha: 'old123' }),
      bugReproReceipt(),
      judgmentReceipt(),
    ]);

    expect(result).toMatchObject({
      ready: false,
      refusals: [expect.objectContaining({
        code: 'stale_receipt',
        receiptId: 'command-1',
        requirement: 'deterministic_command',
      })],
    });
  });

  it('refuses disagreeing independent judgments', () => {
    const result = decision([
      deterministicReceipt(),
      bugReproReceipt(),
      judgmentReceipt(),
      judgmentReceipt({
        id: 'judgment-2',
        actor: { id: 'judge-2', role: 'judge' },
        status: 'failed',
        verdict: 'reject',
      }),
    ]);

    expect(result.ready).toBe(false);
    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'disagreeing_receipts',
        requirement: 'independent_judgment',
      }),
    ]));
  });

  it('refuses when the builder is the sole judge', () => {
    const result = decision([
      deterministicReceipt(),
      bugReproReceipt(),
      judgmentReceipt({ actor: { id: 'builder-1', role: 'judge' } }),
    ]);

    expect(result).toMatchObject({
      ready: false,
      refusals: [{
        code: 'builder_is_sole_judge',
        requirement: 'independent_judgment',
      }],
    });
  });

  it('applies the same refusal policy to automatic completion', () => {
    const result = evaluateAutomaticVerificationReadiness({
      target: 'completion',
      targetCommitSha: commitSha,
      builderActorId: 'builder-1',
      changeClasses: ['code'],
      receipts: [deterministicReceipt()],
    });

    expect(result).toMatchObject({
      ready: false,
      target: 'completion',
      refusals: [{
        code: 'missing_receipt',
        requirement: 'independent_judgment',
      }],
    });
  });

  it('enforces opened visual, external reconciliation, and deployed version payloads', () => {
    const receipts: VerificationReceipt[] = [
      deterministicReceipt(),
      {
        id: 'visual-1',
        kind: 'opened_visual_proof',
        commitSha,
        recordedAt: '2026-08-31T10:01:00.000Z',
        actor: { id: 'verifier-1', role: 'verifier' },
        status: 'passed',
        mediaPath: '/tmp/proof.png',
        openedAt: '2026-08-31T10:01:00.000Z',
        observation: 'The changed state is visible',
      },
      {
        id: 'external-1',
        kind: 'external_effect_reconciliation',
        commitSha,
        recordedAt: '2026-08-31T10:02:00.000Z',
        actor: { id: 'verifier-1', role: 'verifier' },
        status: 'passed',
        system: 'GitHub',
        expectedState: 'PR open',
        observedState: 'PR open',
        reconciled: true,
      },
      {
        id: 'deployment-1',
        kind: 'deployed_version',
        commitSha,
        recordedAt: '2026-08-31T10:03:00.000Z',
        actor: { id: 'verifier-1', role: 'verifier' },
        status: 'passed',
        environment: 'production',
        deployedCommitSha: commitSha,
        version: 'v1.2.3',
      },
      judgmentReceipt(),
    ];
    const input = {
      target: 'completion' as const,
      targetCommitSha: commitSha,
      builderActorId: 'builder-1',
      changeClasses: ['visual_ui', 'external_effect', 'deployment'] as const,
    };

    expect(evaluateAutomaticVerificationReadiness({ ...input, receipts }).ready).toBe(true);
    expect(evaluateAutomaticVerificationReadiness({
      ...input,
      receipts: receipts.map((receipt) => receipt.kind === 'external_effect_reconciliation'
        ? { ...receipt, reconciled: false }
        : receipt),
    }).refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'failed_receipt', receiptId: 'external-1' }),
    ]));
    expect(evaluateAutomaticVerificationReadiness({
      ...input,
      receipts: receipts.map((receipt) => receipt.kind === 'deployed_version'
        ? { ...receipt, deployedCommitSha: 'old123' }
        : receipt),
    }).refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'failed_receipt', receiptId: 'deployment-1' }),
    ]));
  });
});
