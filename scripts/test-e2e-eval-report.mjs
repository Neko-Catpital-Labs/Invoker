import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DIRECT_CONDITION,
  INVOKER_CONDITION,
  HARBOR_DRY_RUN_DOCS,
  buildReport,
  validatePairs,
} from './e2e-eval-report.mjs';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e-eval-report.mjs');

function baseRow(taskId, condition, overrides = {}) {
  return {
    adapterResultSchemaVersion: 1,
    resultSchemaVersion: 1,
    runId: 'report-test-run',
    taskId,
    condition,
    attempt: 1,
    startedAt: '2026-09-22T00:00:00.000Z',
    finishedAt: '2026-09-22T00:00:01.000Z',
    durationMs: condition === DIRECT_CONDITION ? 1_000 : 1_500,
    model: 'report-smoke-model',
    budgetUsd: 0.05,
    solverTimeoutMs: 30_000,
    verifierTimeoutMs: 10_000,
    passed: true,
    graded: 'pass',
    gradeSource: 'verifier-exit-code',
    gradeReason: 'verifier exited 0',
    retries: 0,
    humanRescue: false,
    interruptionRecovery: { kind: 'none', recoveredByVerifier: false, verifierExitCode: 0 },
    infrastructureFailure: null,
    solver: { exitCode: 0, timedOut: false, durationMs: 500 },
    verifier: { exitCode: 0, timedOut: false, durationMs: 200, stdout: 'verifier: ok\n', stderr: '' },
    invoker: condition === INVOKER_CONDITION ? { workflowId: `wf-${taskId}`, taskId: `wf-${taskId}/eval-${taskId}` } : null,
    ...overrides,
  };
}

function matchedRows() {
  return [
    baseRow('write-answer', DIRECT_CONDITION, { spendUsd: 0.01 }),
    baseRow('write-answer', INVOKER_CONDITION, { durationMs: 2_000, spendUsd: 0.02 }),
    baseRow('matched-inputs', DIRECT_CONDITION, { durationMs: 2_000, spendUsd: 0.02 }),
    baseRow('matched-inputs', INVOKER_CONDITION, {
      durationMs: 4_000,
      spendUsd: 0.04,
      passed: false,
      graded: 'fail',
      gradeReason: 'verifier exited 1',
      retries: 1,
      humanRescue: true,
      verifier: { exitCode: 1, timedOut: false, durationMs: 250, stdout: '', stderr: 'missing final state\n' },
    }),
    baseRow('timeout-after-final-state', DIRECT_CONDITION, {
      durationMs: 3_000,
      spendUsd: 0.03,
      interruptionRecovery: { kind: 'solver-timeout', recoveredByVerifier: true, verifierExitCode: 0 },
      solver: { exitCode: null, timedOut: true, durationMs: 900 },
    }),
    baseRow('timeout-after-final-state', INVOKER_CONDITION, {
      durationMs: 6_000,
      spendUsd: 0.06,
      interruptionRecovery: { kind: 'solver-timeout', recoveredByVerifier: true, verifierExitCode: 0 },
      solver: { exitCode: null, timedOut: true, durationMs: 900 },
    }),
  ];
}

function withTempFiles(callback) {
  const root = mkdtempSync(path.join(tmpdir(), 'e2e-eval-report-test-'));
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJsonl(filePath, rows) {
  writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

describe('e2e eval paired report', () => {
  it('summarizes matched direct-agent and invoker rows with required metrics', () => {
    const report = buildReport(matchedRows(), { generatedAt: '2026-09-22T00:00:00.000Z', sources: ['fixture'] });

    assert.equal(report.pairCount, 3);
    assert.equal(report.conditions[DIRECT_CONDITION].verifier.passRate, 1);
    assert.equal(report.conditions[INVOKER_CONDITION].verifier.passed, 2);
    assert.equal(report.conditions[INVOKER_CONDITION].durationMs.total, 12_000);
    assert.equal(report.conditions[INVOKER_CONDITION].spendUsd.total, 0.12);
    assert.deepEqual(report.conditions[INVOKER_CONDITION].spendUsd.sourceCounts, { spendUsd: 3 });
    assert.equal(report.conditions[INVOKER_CONDITION].retries.total, 1);
    assert.equal(report.conditions[INVOKER_CONDITION].humanRescue.count, 1);
    assert.equal(report.conditions[DIRECT_CONDITION].recovery.recoveredByVerifier, 1);
    assert.equal(report.conditions[INVOKER_CONDITION].failures['human-intervention'], 1);
    assert.equal(report.deltas.invokerMinusDirect.durationMs.total, 6_000);
    assert.equal(report.deltas.invokerMinusDirect.spendUsd.total, 0.06);
    assert.match(report.harbor.dryRunDocs, /opt-in/);
    assert.ok(report.harbor.mapping.some((entry) => entry.harborField === 'invoker_verifier_passed'));
  });

  it('rejects unmatched rows with a clear pair error', () => {
    const rows = matchedRows().filter((row) => !(row.taskId === 'write-answer' && row.condition === INVOKER_CONDITION));

    assert.throws(
      () => validatePairs(rows),
      /unmatched row set for task write-answer attempt 1: missing condition\(s\) invoker/,
    );
  });

  it('rejects matched rows whose inputs differ between conditions', () => {
    const rows = matchedRows();
    rows.find((row) => row.taskId === 'write-answer' && row.condition === INVOKER_CONDITION).model = 'different-model';

    assert.throws(
      () => validatePairs(rows),
      /matched input mismatch for write-answer attempt 1: field model differs across conditions/,
    );
  });

  it('CLI exits 0 for matched fixtures and prints all required metric sections', () => withTempFiles((root) => {
    const resultPath = path.join(root, 'matched.jsonl');
    writeJsonl(resultPath, matchedRows());

    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--results', resultPath, '--harbor-dry-run'], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verifier pass rate:/);
    assert.match(result.stdout, /Duration:/);
    assert.match(result.stdout, /Spend:/);
    assert.match(result.stdout, /Retries:/);
    assert.match(result.stdout, /Human rescue:/);
    assert.match(result.stdout, /Recovery:/);
    assert.match(result.stdout, /Harbor mapping:/);
    assert.match(result.stdout, new RegExp(HARBOR_DRY_RUN_DOCS.slice(0, 30)));
  }));

  it('CLI exits non-zero for unmatched fixtures with a clear error', () => withTempFiles((root) => {
    const resultPath = path.join(root, 'unmatched.jsonl');
    writeJsonl(resultPath, matchedRows().filter((row) => !(row.taskId === 'matched-inputs' && row.condition === DIRECT_CONDITION)));

    const result = spawnSync(process.execPath, [SCRIPT_PATH, resultPath], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unmatched row set for task matched-inputs attempt 1/);
    assert.match(result.stderr, /missing condition\(s\) direct-agent/);
  }));

  it('CLI --json includes Harbor dry-run docs and mapping without uploading', () => withTempFiles((root) => {
    const resultPath = path.join(root, 'matched.jsonl');
    writeJsonl(resultPath, matchedRows());

    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--results', resultPath, '--json'], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.harbor.optIn, true);
    assert.match(parsed.harbor.dryRunDocs, /never uploads/);
    assert.ok(parsed.harbor.mapping.length > 0);
  }));
});
