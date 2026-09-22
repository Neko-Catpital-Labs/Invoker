#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  DIRECT_CONDITION,
  INVOKER_CONDITION,
  buildReport,
  readJsonl,
} from './e2e-eval-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_SCRIPT = resolve(__dirname, 'e2e-eval-report.mjs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function baseRow({ taskId, condition, attempt = 1, passed = true, durationMs, spendUsd, retries = 0, humanRescue = false, recovery = false }) {
  return {
    schemaVersion: 1,
    runId: `${condition}-fixture`,
    taskId,
    prompt: `Do ${taskId}`,
    model: 'gpt-5-codex',
    budgetUsd: 0.05,
    condition,
    attempt,
    passed,
    verdict: passed ? 'pass' : 'fail',
    durationMs,
    spendUsd,
    retries,
    humanRescue,
    infrastructureFailure: false,
    infrastructureFailures: recovery ? [{ attempt: 1, failure: { kind: 'interrupted', detail: 'exit 143' } }] : [],
    interruptionRecovered: recovery,
    verifierOutput: { stdout: passed ? 'verifier: pass\n' : 'verifier: fail\n', stderr: '' },
    verifier: { exitCode: passed ? 0 : 1, timedOut: false, spawnError: null },
  };
}

function matchedRows() {
  return [
    baseRow({ taskId: 'direct-write-pass', condition: DIRECT_CONDITION, durationMs: 1000, spendUsd: 0.01 }),
    baseRow({ taskId: 'direct-write-pass', condition: INVOKER_CONDITION, durationMs: 1300, spendUsd: 0.02 }),
    baseRow({ taskId: 'claim-only-fails', condition: DIRECT_CONDITION, passed: false, durationMs: 2000, spendUsd: 0.03 }),
    baseRow({ taskId: 'claim-only-fails', condition: INVOKER_CONDITION, passed: true, durationMs: 2400, spendUsd: 0.04, humanRescue: true }),
    baseRow({ taskId: 'interruption-recovers', condition: DIRECT_CONDITION, attempt: 2, durationMs: 1500, spendUsd: 0.05, retries: 1, recovery: true }),
    baseRow({ taskId: 'interruption-recovers', condition: INVOKER_CONDITION, attempt: 2, durationMs: 1900, spendUsd: 0.06, retries: 1, recovery: true }),
  ];
}

function runReport(args) {
  return spawnSync(process.execPath, [REPORT_SCRIPT, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function assertOutputContainsAll(output, labels) {
  for (const label of labels) {
    assert(output.includes(label), `report output should include ${JSON.stringify(label)}`);
  }
}

function main() {
  const tempDir = mkdtempSync(join(tmpdir(), 'invoker-e2e-eval-report-test-'));
  try {
    const matchedPath = join(tempDir, 'matched.jsonl');
    const unmatchedPath = join(tempDir, 'unmatched.jsonl');
    writeJsonl(matchedPath, matchedRows());
    writeJsonl(unmatchedPath, matchedRows().filter((row) => !(row.taskId === 'claim-only-fails' && row.condition === INVOKER_CONDITION)));

    const report = buildReport(readJsonl(matchedPath));
    assert(report.pairCount === 3, 'matched fixture should produce three pairs');
    assert(report.conditions[DIRECT_CONDITION].verifierPasses === 2, 'direct verifier pass count should be 2');
    assert(report.conditions[INVOKER_CONDITION].verifierPasses === 3, 'invoker verifier pass count should be 3');
    assert(report.conditions[DIRECT_CONDITION].durationMs === 4500, 'direct total duration should be reported');
    assert(Math.abs(report.conditions[INVOKER_CONDITION].spendUsd - 0.12) < 0.000001, 'invoker spend should be summed');
    assert(report.conditions[INVOKER_CONDITION].humanRescue === 1, 'human rescue should be counted separately');
    assert(report.conditions[DIRECT_CONDITION].recovery === 1, 'recovery should be counted separately');
    assert(report.conditions[DIRECT_CONDITION].retries === 1, 'retries should be summed');

    const matchedCli = runReport(['--results', matchedPath]);
    assert(matchedCli.status === 0, `matched fixture should exit 0: ${matchedCli.stderr}`);
    assertOutputContainsAll(matchedCli.stdout, [
      'verifier pass rate',
      'duration total',
      'spend',
      'retries',
      'human rescue',
      'recovery',
      'Harbor dry-run mapping',
      'No Harbor writes',
    ]);

    const harborJson = runReport(['--results', matchedPath, '--json', '--harbor-dry-run']);
    assert(harborJson.status === 0, `harbor dry-run JSON should exit 0: ${harborJson.stderr}`);
    const harborReport = JSON.parse(harborJson.stdout);
    assert(harborReport.harborDryRun.requested === true, 'harbor dry-run should be marked requested');
    assert(harborReport.harborDryRun.writes === false, 'harbor dry-run should document no writes');
    assert(harborReport.harborDryRun.records.length === 3, 'harbor dry-run should map one record per pair');

    const unmatchedCli = runReport(['--results', unmatchedPath]);
    assert(unmatchedCli.status !== 0, 'unmatched fixture should exit non-zero');
    assert(unmatchedCli.stderr.includes('unmatched pair'), 'unmatched fixture should fail clearly');
    assert(unmatchedCli.stderr.includes('missing invoker'), 'unmatched fixture should name the missing condition');

    console.log('PASS e2e-eval-report tests: matched metrics, unmatched rejection, Harbor dry-run docs');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`FAIL e2e-eval-report tests: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
}
