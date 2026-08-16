import { describe, it, expect, vi } from 'vitest';
import { runHeadless } from '../headless.js';

function makeDeps(insertRepairFiling: ReturnType<typeof vi.fn>, deleteRepairFiling?: ReturnType<typeof vi.fn>) {
  return {
    persistence: { insertRepairFiling, deleteRepairFiling } as any,
  } as any;
}

describe('headless repair-filing insert', () => {
  it('inserts a new (kind, subject, stateSha) row and prints the result as JSON', async () => {
    const insertRepairFiling = vi.fn(() => ({
      inserted: true,
      row: { id: 1, kind: 'ci-regression:required-fast-guardrails', subject: 'master', stateSha: 'sha-a', metadata: null, createdAt: '2026-08-16T00:00:00.000Z' },
    }));
    const deps = makeDeps(insertRepairFiling);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['repair-filing', 'insert', '--kind', 'ci-regression:required-fast-guardrails', '--subject', 'master', '--state-sha', 'sha-a'], deps);

    expect(insertRepairFiling).toHaveBeenCalledWith({
      kind: 'ci-regression:required-fast-guardrails',
      subject: 'master',
      stateSha: 'sha-a',
      metadata: null,
    });
    const printed = JSON.parse(write.mock.calls.map(([chunk]) => String(chunk)).join(''));
    expect(printed.inserted).toBe(true);
    write.mockRestore();
  });

  it('reports inserted: false for a duplicate key without throwing', async () => {
    const insertRepairFiling = vi.fn(() => ({
      inserted: false,
      row: { id: 1, kind: 'admin-requeue:rebase-conflict', subject: '9425', stateSha: 'sha-b', metadata: null, createdAt: '2026-08-16T00:00:00.000Z' },
    }));
    const deps = makeDeps(insertRepairFiling);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['repair-filing', 'insert', '--kind', 'admin-requeue:rebase-conflict', '--subject', '9425', '--state-sha', 'sha-b'], deps);

    const printed = JSON.parse(write.mock.calls.map(([chunk]) => String(chunk)).join(''));
    expect(printed.inserted).toBe(false);
    write.mockRestore();
  });

  it('parses --metadata as JSON and passes it through', async () => {
    const insertRepairFiling = vi.fn(() => ({
      inserted: true,
      row: { id: 2, kind: 'ci-regression:fleet', subject: 'master', stateSha: 'sha-c', metadata: { memberJobs: ['a', 'b'] }, createdAt: '2026-08-16T00:00:00.000Z' },
    }));
    const deps = makeDeps(insertRepairFiling);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['repair-filing', 'insert', '--kind', 'ci-regression:fleet', '--subject', 'master', '--state-sha', 'sha-c', '--metadata', '{"memberJobs":["a","b"]}'], deps);

    expect(insertRepairFiling).toHaveBeenCalledWith({
      kind: 'ci-regression:fleet',
      subject: 'master',
      stateSha: 'sha-c',
      metadata: { memberJobs: ['a', 'b'] },
    });
  });

  it('throws a usage error when a required flag is missing', async () => {
    const deps = makeDeps(vi.fn());
    await expect(runHeadless(['repair-filing', 'insert', '--kind', 'k'], deps)).rejects.toThrow('Usage: --headless repair-filing');
  });

  it('throws a usage error for an unknown subcommand', async () => {
    const deps = makeDeps(vi.fn());
    await expect(runHeadless(['repair-filing', 'bogus'], deps)).rejects.toThrow('Usage: --headless repair-filing');
  });

  it('release calls deleteRepairFiling and reports whether a row was actually removed', async () => {
    const deleteRepairFiling = vi.fn(() => true);
    const deps = makeDeps(vi.fn(), deleteRepairFiling);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['repair-filing', 'release', '--kind', 'ci-regression:required-fast-guardrails', '--subject', 'master', '--state-sha', 'sha-a'], deps);

    expect(deleteRepairFiling).toHaveBeenCalledWith('ci-regression:required-fast-guardrails', 'master', 'sha-a');
    const printed = JSON.parse(write.mock.calls.map(([chunk]) => String(chunk)).join(''));
    expect(printed.released).toBe(true);
    write.mockRestore();
  });
});
