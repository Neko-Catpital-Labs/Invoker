import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  advanceVerifierWorkflow,
  canonicalVerifierFindingKey,
  compileVerificationRequirements,
  createVerifierWorkflow,
  isTrustedVerificationEvidenceRecord,
  parseVerificationEvidenceRecord,
  type LegacyUntrustedVerificationEvidenceRecord,
  type TrustedVerificationEvidenceRecord,
  type VerificationEvidenceRecord,
} from '../verification-contract.js';

const commandReceipt = {
  id: 'command-1',
  kind: 'deterministic_command' as const,
  commitSha: 'abc123',
  recordedAt: '2026-08-31T10:00:00.000Z',
  actor: { id: 'builder-1', role: 'builder' as const },
  status: 'passed' as const,
  command: 'pnpm test',
  exitCode: 0,
  output: 'Tests passed',
};

function trustedCommandRecord(): unknown {
  return {
    version: 2,
    trust: 'trusted',
    receipt: commandReceipt,
    attestation: {
      repository: 'Neko-Catpital-Labs/Invoker',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      generation: 2,
      attemptId: 'wf-1/task-1-a1',
      commitSha: 'abc123',
      canonicalPayloadDigest: 'sha256:receipt-digest',
      signatureAlgorithm: 'Ed25519',
      signature: 'base64-signature',
      trustedKeyId: 'executor-key-1',
      provider: { kind: 'executor', providerId: 'codex' },
      actorId: 'builder-1',
      issuedAt: '2026-08-31T09:59:59.000Z',
      recordedAt: '2026-08-31T10:00:00.000Z',
    },
  };
}

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

describe('verification evidence record contract', () => {
  it('keeps version-1 receipts readable but explicitly untrusted', () => {
    const legacy: VerificationEvidenceRecord = {
      version: 1,
      trust: 'untrusted',
      receipt: commandReceipt,
    };

    expect(parseVerificationEvidenceRecord(legacy)).toEqual(legacy);
    expect(isTrustedVerificationEvidenceRecord(legacy)).toBe(false);
    expectTypeOf<LegacyUntrustedVerificationEvidenceRecord>()
      .not.toMatchTypeOf<TrustedVerificationEvidenceRecord>();
  });

  it('parses a complete version-2 attested receipt as trusted evidence', () => {
    const parsed = parseVerificationEvidenceRecord(trustedCommandRecord());

    expect(parsed).toMatchObject({
      version: 2,
      trust: 'trusted',
      attestation: {
        repository: 'Neko-Catpital-Labs/Invoker',
        workflowId: 'wf-1',
        taskId: 'wf-1/task-1',
        generation: 2,
        attemptId: 'wf-1/task-1-a1',
        commitSha: 'abc123',
        canonicalPayloadDigest: 'sha256:receipt-digest',
        signatureAlgorithm: 'Ed25519',
        signature: 'base64-signature',
        trustedKeyId: 'executor-key-1',
        provider: { kind: 'executor', providerId: 'codex' },
        actorId: 'builder-1',
        issuedAt: '2026-08-31T09:59:59.000Z',
        recordedAt: '2026-08-31T10:00:00.000Z',
      },
    });
    expect(isTrustedVerificationEvidenceRecord(trustedCommandRecord())).toBe(true);
  });

  it('accepts an attestation without an attempt ID', () => {
    const input = trustedCommandRecord() as {
      attestation: Record<string, unknown>;
    };
    delete input.attestation.attemptId;

    const parsed = parseVerificationEvidenceRecord(input);

    expect(parsed.version).toBe(2);
    if (parsed.version !== 2) return;
    expect(parsed.attestation.attemptId).toBeUndefined();
  });

  it.each([
    'repository',
    'workflowId',
    'taskId',
    'generation',
    'commitSha',
    'canonicalPayloadDigest',
    'signatureAlgorithm',
    'signature',
    'trustedKeyId',
    'provider',
    'actorId',
    'issuedAt',
    'recordedAt',
  ])('rejects a version-2 record missing attestation.%s', (field) => {
    const input = trustedCommandRecord() as {
      attestation: Record<string, unknown>;
    };
    delete input.attestation[field];

    expect(() => parseVerificationEvidenceRecord(input)).toThrow(field);
    expect(isTrustedVerificationEvidenceRecord(input)).toBe(false);
  });

  it('rejects malformed records instead of allowing them to claim trust', () => {
    expect(() => parseVerificationEvidenceRecord({
      version: 2,
      trust: 'trusted',
      receipt: commandReceipt,
      attestation: {
        ...((trustedCommandRecord() as { attestation: object }).attestation),
        signatureAlgorithm: 'self-asserted',
      },
    })).toThrow(/Ed25519/);
    expect(isTrustedVerificationEvidenceRecord({
      version: 1,
      trust: 'trusted',
      receipt: commandReceipt,
    })).toBe(false);
  });

  it('carries distinct provider identities for independent judges', () => {
    const judgmentReceipt = {
      ...commandReceipt,
      id: 'judgment-1',
      kind: 'independent_judgment' as const,
      actor: { id: 'judge-actor', role: 'judge' as const },
      verdict: 'approve' as const,
      rationale: 'The evidence satisfies the contract',
    };
    const codex = trustedCommandRecord() as {
      receipt: unknown;
      attestation: Record<string, unknown>;
    };
    codex.receipt = judgmentReceipt;
    codex.attestation.provider = { kind: 'judge', providerId: 'codex' };
    codex.attestation.actorId = 'judge-actor';
    codex.attestation.trustedKeyId = 'codex-judge-key';
    const claude = structuredClone(codex);
    claude.attestation.provider = { kind: 'judge', providerId: 'claude' };
    claude.attestation.trustedKeyId = 'claude-judge-key';

    const codexParsed = parseVerificationEvidenceRecord(codex);
    const claudeParsed = parseVerificationEvidenceRecord(claude);

    expect(codexParsed.version).toBe(2);
    expect(claudeParsed.version).toBe(2);
    if (codexParsed.version !== 2 || claudeParsed.version !== 2) return;
    expect(codexParsed.attestation.actorId).toBe(claudeParsed.attestation.actorId);
    expect(codexParsed.attestation.provider.providerId).not.toBe(claudeParsed.attestation.provider.providerId);
    expect(codexParsed.attestation.trustedKeyId).not.toBe(claudeParsed.attestation.trustedKeyId);
  });
});
