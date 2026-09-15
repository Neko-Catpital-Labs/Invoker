#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CLI = join(ROOT, 'scripts/build-bench.mjs');

function tmpRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `build-bench-${name}-`));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: name, private: true }, null, 2));
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  return root;
}

function writeCases(root, cases, suite = 'self') {
  const file = join(root, 'cases.json');
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    stageId: 'self-test',
    originalReference: 'self',
    suite,
    cachePolicy: 'self-test',
    cases
  }, null, 2));
  return file;
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    ...opts
  });
}

function runStage(root, cases, extra = []) {
  const casesPath = writeCases(root, cases);
  const out = join(root, 'receipt.json');
  const res = runCli([
    'stage',
    '--root', root,
    '--cases', casesPath,
    '--out', out,
    '--suite', 'self',
    '--repetitions', '1',
    '--no-clone',
    ...extra
  ]);
  return { res, out, receipt: res.status === 0 || res.status === 1 ? JSON.parse(readFileSync(out, 'utf8')) : null };
}

test('captures real child-process timing for a passing case', () => {
  const root = tmpRoot('timer');
  const { res, receipt } = runStage(root, [{
    id: 'timer',
    suite: 'self',
    kind: 'probe',
    cwd: '.',
    argv: [process.execPath, '-e', 'setTimeout(() => console.log("done"), 25)'],
    artifacts: []
  }], ['--strict']);
  assert.equal(res.status, 0, res.stderr);
  const sample = receipt.cases[0].samples[0];
  assert.equal(receipt.cases[0].status, 'passed');
  assert.ok(sample.elapsedMs > 0);
  assert.match(readFileSync(sample.logPath, 'utf8'), /done/);
});

test('propagates nonzero child-process status into a failed case', () => {
  const root = tmpRoot('nonzero');
  const { res, receipt } = runStage(root, [{
    id: 'nonzero',
    suite: 'self',
    kind: 'probe',
    cwd: '.',
    argv: [process.execPath, '-e', 'process.exit(7)'],
    artifacts: []
  }], ['--strict']);
  assert.equal(res.status, 1);
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.cases[0].status, 'failed');
  assert.equal(receipt.cases[0].samples[0].exitCode, 7);
});

test('marks timed out child processes as timed_out', () => {
  const root = tmpRoot('timeout');
  const { res, receipt } = runStage(root, [{
    id: 'timeout',
    suite: 'self',
    kind: 'probe',
    cwd: '.',
    timeoutMs: 50,
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
    artifacts: []
  }], ['--strict']);
  assert.equal(res.status, 1);
  assert.equal(receipt.cases[0].status, 'timed_out');
  assert.equal(receipt.cases[0].samples[0].timedOut, true);
});

test('rejects a successful command with a missing required report', () => {
  const root = tmpRoot('missing-report');
  const { res, receipt } = runStage(root, [{
    id: 'missing-report',
    suite: 'self',
    kind: 'probe',
    cwd: '.',
    argv: [process.execPath, '-e', 'console.log("ok")'],
    expectedReports: ['missing.json'],
    artifacts: []
  }], ['--strict']);
  assert.equal(res.status, 1);
  assert.equal(receipt.cases[0].status, 'missing_report');
});

test('rejects package-test cases with zero discovered tests unless the script is literal no-op', () => {
  const root = tmpRoot('zero-tests');
  const pkg = join(root, 'packages/empty');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: '@fixture/empty',
    scripts: { test: 'vitest run' }
  }, null, 2));
  const { res, receipt } = runStage(root, [{
    id: 'zero-tests',
    suite: 'self',
    kind: 'package-test',
    cwd: '.',
    packageName: '@fixture/empty',
    packageDir: 'packages/empty',
    discoveredTestIds: [],
    argv: [process.execPath, '-e', 'console.log("would run tests")'],
    artifacts: []
  }], ['--strict']);
  assert.equal(res.status, 1);
  assert.equal(receipt.cases[0].status, 'zero_tests');
});

test('records literal no-op test scripts as no_tests', () => {
  const root = tmpRoot('noop-tests');
  const { res, receipt } = runStage(root, [{
    id: 'noop-tests',
    suite: 'self',
    kind: 'package-test',
    cwd: '.',
    packageName: '@fixture/noop',
    literalNoopTestScript: true,
    discoveredTestIds: [],
    argv: [process.execPath, '-e', 'process.exit(99)'],
    artifacts: []
  }], ['--strict']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(receipt.cases[0].status, 'no_tests');
  assert.deepEqual(receipt.cases[0].samples, []);
});

test('compare rejects mismatched requested scope', () => {
  const root = tmpRoot('mismatch');
  const baseline = join(root, 'baseline.json');
  const candidate = join(root, 'candidate.json');
  const baseCase = {
    id: 'same',
    status: 'passed',
    argv: ['node', '-e', '1'],
    artifacts: [{ path: 'a' }],
    testIds: ['test-a'],
    stats: { medianMs: 10 }
  };
  writeFileSync(baseline, JSON.stringify({ cases: [baseCase] }));
  writeFileSync(candidate, JSON.stringify({
    cases: [{ ...baseCase, artifacts: [{ path: 'b' }], stats: { medianMs: 9 } }]
  }));
  const res = runCli(['compare', '--baseline', baseline, '--candidate', candidate]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /mismatched scope/);
});

test('rejects deliberately stale outputs', () => {
  const root = tmpRoot('stale-output');
  const { res, receipt } = runStage(root, [{
    id: 'stale',
    suite: 'self',
    kind: 'probe',
    cwd: '.',
    argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("out.txt", "stale")'],
    rejectIfOutputEquals: { path: 'out.txt', value: 'stale' },
    artifacts: ['out.txt']
  }], ['--strict']);
  assert.equal(res.status, 1);
  assert.equal(receipt.cases[0].status, 'stale_output');
});
