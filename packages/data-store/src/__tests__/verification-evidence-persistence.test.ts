import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseVerificationEvidenceRecord,
  type LegacyUntrustedVerificationEvidenceRecord,
  type TrustedVerificationEvidenceRecord,
} from '@invoker/contracts';
import { SQLiteAdapter } from '../sqlite-adapter.js';

const recordedAt = '2026-08-31T12:00:00.000Z';

function trustedEvidence(
  id: string,
  overrides: Partial<TrustedVerificationEvidenceRecord['attestation']> = {},
): TrustedVerificationEvidenceRecord {
  const commitSha = overrides.commitSha ?? 'commit-current';
  return {
    version: 2,
    trust: 'trusted',
    receipt: {
      id,
      kind: 'deterministic_command',
      commitSha,
      recordedAt,
      actor: { id: 'executor-1', role: 'verifier' },
      status: 'passed',
      command: 'pnpm test',
      exitCode: 0,
      output: 'passed',
    },
    attestation: {
      repository: 'invoker/invoker',
      workflowId: 'wf-1',
      taskId: 'task-1',
      generation: 3,
      attemptId: 'attempt-2',
      commitSha,
      canonicalPayloadDigest: `digest-${id}`,
      signatureAlgorithm: 'Ed25519',
      signature: `signature-${id}`,
      trustedKeyId: 'key-1',
      provider: { kind: 'executor', providerId: 'codex' },
      actorId: 'executor-1',
      issuedAt: recordedAt,
      recordedAt,
      ...overrides,
    },
  };
}

function legacyEvidence(id: string): LegacyUntrustedVerificationEvidenceRecord {
  return {
    version: 1,
    trust: 'untrusted',
    receipt: {
      id,
      kind: 'deterministic_command',
      commitSha: 'legacy-commit',
      recordedAt,
      actor: { id: 'legacy-runner', role: 'verifier' },
      status: 'passed',
      command: 'pnpm test',
      exitCode: 0,
      output: 'legacy pass',
    },
  };
}

describe('verification evidence persistence', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('validates records before insertion and stores canonical JSON', () => {
    const malformed = {
      ...trustedEvidence('malformed'),
      attestation: {
        ...trustedEvidence('malformed').attestation,
        signature: '',
      },
    };

    expect(() => adapter.appendVerificationEvidence(malformed)).toThrow(
      'attestation.signature must be a non-empty string',
    );
    expect(adapter.listVerificationEvidenceForAudit()).toEqual([]);

    const input = { ...trustedEvidence('canonical'), ignored: 'not persisted' };
    adapter.appendVerificationEvidence(input);

    const row = (adapter as any).db
      .prepare('SELECT record_json FROM verification_evidence WHERE receipt_id = ?')
      .get('canonical') as { record_json: string };
    expect(row.record_json).toBe(JSON.stringify(parseVerificationEvidenceRecord(input)));
  });

  it('rejects duplicate receipt identity instead of replacing evidence', () => {
    adapter.appendVerificationEvidence(trustedEvidence('duplicate'));

    expect(() => adapter.appendVerificationEvidence(
      trustedEvidence('duplicate', { generation: 4 }),
    )).toThrow(/UNIQUE constraint failed: verification_evidence\.receipt_id/);
    expect(adapter.listVerificationEvidenceForAudit()).toHaveLength(1);
  });

  it('rejects UPDATE and DELETE at the SQLite boundary', () => {
    adapter.appendVerificationEvidence(trustedEvidence('immutable'));

    expect(() => (adapter as any).db.run(
      "UPDATE verification_evidence SET commit_sha = 'mutated' WHERE receipt_id = 'immutable'",
    )).toThrow('verification_evidence rows are immutable');
    expect(() => (adapter as any).db.run(
      "DELETE FROM verification_evidence WHERE receipt_id = 'immutable'",
    )).toThrow('verification_evidence rows are immutable');
    expect(adapter.listVerificationEvidenceForAudit()).toEqual([
      trustedEvidence('immutable'),
    ]);
  });

  it('returns trusted evidence only for the complete exact scope', () => {
    const rows = [
      trustedEvidence('exact'),
      trustedEvidence('wrong-repository', { repository: 'invoker/other' }),
      trustedEvidence('wrong-workflow', { workflowId: 'wf-2' }),
      trustedEvidence('wrong-task', { taskId: 'task-2' }),
      trustedEvidence('wrong-generation', { generation: 2 }),
      trustedEvidence('wrong-attempt', { attemptId: 'attempt-1' }),
      trustedEvidence('no-attempt', { attemptId: undefined }),
      trustedEvidence('wrong-commit', { commitSha: 'commit-stale' }),
    ];
    for (const row of rows) adapter.appendVerificationEvidence(row);

    expect(adapter.loadTrustedVerificationEvidence({
      repository: 'invoker/invoker',
      workflowId: 'wf-1',
      taskId: 'task-1',
      generation: 3,
      attemptId: 'attempt-2',
      commitSha: 'commit-current',
    })).toEqual([trustedEvidence('exact')]);
  });

  it('keeps legacy evidence available to audit reads but never trusted reads', () => {
    const legacy = legacyEvidence('legacy');
    adapter.appendVerificationEvidence(legacy);

    expect(adapter.listVerificationEvidenceForAudit()).toEqual([legacy]);
    expect(adapter.loadTrustedVerificationEvidence({
      repository: 'invoker/invoker',
      workflowId: 'wf-1',
      taskId: 'task-1',
      generation: 3,
      attemptId: 'attempt-2',
      commitSha: 'legacy-commit',
    })).toEqual([]);
  });
});
