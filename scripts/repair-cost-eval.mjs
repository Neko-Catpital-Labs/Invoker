#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_DIR = join(ROOT, 'evals', 'repair-cost');
const FIXTURES = join(EVAL_DIR, 'fixtures');
const STATUS_SH = join(EVAL_DIR, 'status.sh');

export const STATUS_BAND_FACTOR = 3;
export const CLASSES = ['merge-conflict', 'test-failure'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function readStatusLine(failureClass) {
  const out = execFileSync('bash', [STATUS_SH, failureClass], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  return out.trimEnd();
}

export function loadFixtureLog(failureClass) {
  const path = join(FIXTURES, `${failureClass}.log`);
  assert(existsSync(path), `missing fixture log: ${path}`);
  return readFileSync(path, 'utf8');
}

export function buildSplitPrompt(failureClass, statusLine) {
  return [
    `Repair the ${failureClass} failure.`,
    'Poll status only via:',
    `  bash evals/repair-cost/status.sh ${failureClass}`,
    'Do not read raw logs, gh output, or verify-command transcripts.',
    'Current status:',
    statusLine,
    '',
  ].join('\n');
}

export function buildCombinedStatusPrompt(statusByClass) {
  const lines = CLASSES.map((c) => statusByClass[c]);
  return [
    'Coordinate these failure classes. Each class keeps its own claim and agent.',
    'Poll status only via:',
    '  bash evals/repair-cost/status.sh <merge-conflict|test-failure>',
    'Do not read raw logs, gh output, or verify-command transcripts.',
    'Statuses:',
    ...lines,
    '',
  ].join('\n');
}

export function buildCombinedLogsPrompt(logsByClass) {
  const parts = [];
  for (const c of CLASSES) {
    parts.push(`--- ${c} ---`, logsByClass[c], '');
  }
  return [
    'Repair both failures. Full logs follow.',
    ...parts,
  ].join('\n');
}

export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

export function measureArms() {
  const statusByClass = Object.fromEntries(
    CLASSES.map((c) => [c, readStatusLine(c)]),
  );
  const logsByClass = Object.fromEntries(
    CLASSES.map((c) => [c, loadFixtureLog(c)]),
  );

  const splitPrompts = Object.fromEntries(
    CLASSES.map((c) => [c, buildSplitPrompt(c, statusByClass[c])]),
  );
  const combinedStatus = buildCombinedStatusPrompt(statusByClass);
  const combinedLogs = buildCombinedLogsPrompt(logsByClass);

  const splitBytes = Object.fromEntries(
    CLASSES.map((c) => [c, byteLength(splitPrompts[c])]),
  );
  const oneSplitBytes = Math.max(...Object.values(splitBytes));
  const fixtureBytes = Object.fromEntries(
    CLASSES.map((c) => [c, byteLength(logsByClass[c])]),
  );
  const fixtureSum = Object.values(fixtureBytes).reduce((a, b) => a + b, 0);

  return {
    splitBytes,
    oneSplitBytes,
    combinedStatusBytes: byteLength(combinedStatus),
    combinedLogsBytes: byteLength(combinedLogs),
    fixtureBytes,
    fixtureSum,
    statusBandFactor: STATUS_BAND_FACTOR,
    prompts: {
      split: splitPrompts,
      combinedStatus,
      combinedLogs,
    },
  };
}

export function runSelfTest() {
  for (const c of CLASSES) {
    const line = readStatusLine(c);
    assert(line.length > 0, `status.sh ${c} printed empty line`);
    assert(line.length < 200, `status.sh ${c} line too long (${line.length})`);
    assert(!line.includes('\n'), `status.sh ${c} must print a single line`);
  }

  const m = measureArms();

  assert(
    m.combinedStatusBytes <= m.oneSplitBytes * STATUS_BAND_FACTOR,
    `combined-status (${m.combinedStatusBytes} B) exceeds ${STATUS_BAND_FACTOR}x one split prompt (${m.oneSplitBytes} B)`,
  );

  assert(
    m.combinedLogsBytes >= m.oneSplitBytes + m.fixtureSum * 0.9,
    `combined-logs (${m.combinedLogsBytes} B) should include fixture size (~${m.fixtureSum} B) beyond one split (${m.oneSplitBytes} B)`,
  );

  assert(
    m.combinedLogsBytes > m.combinedStatusBytes * 10,
    `combined-logs (${m.combinedLogsBytes} B) must be >> combined-status (${m.combinedStatusBytes} B)`,
  );

  for (const c of CLASSES) {
    assert(
      m.fixtureBytes[c] >= 20_000,
      `fixture ${c}.log too small (${m.fixtureBytes[c]} B); keep logs large so cat'ing is expensive`,
    );
  }

  return m;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/repair-cost-eval.mjs --self-test | --print-metrics');
    process.exit(0);
  }

  if (args.includes('--self-test')) {
    const m = runSelfTest();
    console.log(
      `[repair-cost-eval] self-test OK: oneSplit=${m.oneSplitBytes}B `
        + `combinedStatus=${m.combinedStatusBytes}B `
        + `combinedLogs=${m.combinedLogsBytes}B `
        + `statusBandFactor=${STATUS_BAND_FACTOR}`,
    );
    process.exit(0);
  }

  if (args.includes('--print-metrics')) {
    const m = measureArms();
    console.log(JSON.stringify({
      splitBytes: m.splitBytes,
      oneSplitBytes: m.oneSplitBytes,
      combinedStatusBytes: m.combinedStatusBytes,
      combinedLogsBytes: m.combinedLogsBytes,
      fixtureBytes: m.fixtureBytes,
      fixtureSum: m.fixtureSum,
      statusBandFactor: m.statusBandFactor,
    }, null, 2));
    process.exit(0);
  }

  console.error('Usage: node scripts/repair-cost-eval.mjs --self-test | --print-metrics');
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv);
}
