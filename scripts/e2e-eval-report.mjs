#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

export const DIRECT_CONDITION = 'direct-agent';
export const INVOKER_CONDITION = 'invoker';
export const EXPECTED_CONDITIONS = [DIRECT_CONDITION, INVOKER_CONDITION];

const USAGE = [
  'usage: e2e-eval-report.mjs --results <path> [--results <path>...] [--json] [--harbor-dry-run]',
  '',
  'Reads local evaluation JSONL result files and reports paired direct-agent vs',
  'Invoker engineering outcomes. Pairing is strict: every taskId + attempt must',
  'have exactly one direct-agent row and one invoker row, with matching prompt,',
  'model, and budgetUsd values.',
  '',
  'Metrics printed per condition: verifier pass rate, duration, spend, retries,',
  'human rescue, interrupted recovery, infrastructure failures, agent failures,',
  'and verifier errors. Success is derived from independent verifier fields',
  '(passed/verdict), not workflow status.',
  '',
  'Harbor mapping is opt-in and dry-run only here. Use --harbor-dry-run to print',
  'the records that a future Harbor importer could consume; this command never',
  'writes to Harbor or changes local evaluation semantics.',
].join('\n');

function formatUsd(value) {
  return `$${value.toFixed(4)}`;
}

function signedUsd(value) {
  const sign = value > 0 ? '+' : '';
  return `${sign}$${value.toFixed(4)}`;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function signedNumber(value, suffix = '') {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value}${suffix}`;
}

function signedFixed(value, digits, suffix = '') {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}${suffix}`;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nestedFinite(row, path) {
  let current = row;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return null;
    current = current[key];
  }
  return finiteNumber(current);
}

function firstFinite(row, paths) {
  for (const path of paths) {
    const value = nestedFinite(row, path);
    if (value !== null) return value;
  }
  return null;
}

export function readJsonl(path) {
  const resolved = resolve(path);
  return readFileSync(resolved, 'utf8')
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter(({ line }) => line !== '')
    .map(({ line, index }) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${resolved}:${index}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
      }
    });
}

export function readResultFiles(paths) {
  return paths.flatMap((path) => readJsonl(path));
}

function requireRowShape(row, index) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`row ${index + 1} must be a JSON object`);
  }
  if (typeof row.taskId !== 'string' || row.taskId.trim() === '') {
    throw new Error(`row ${index + 1} taskId must be a non-empty string`);
  }
  if (!EXPECTED_CONDITIONS.includes(row.condition)) {
    throw new Error(`row ${index + 1} has unsupported condition ${JSON.stringify(row.condition)}; expected ${EXPECTED_CONDITIONS.join(' or ')}`);
  }
  if (!Number.isInteger(row.attempt) || row.attempt <= 0) {
    throw new Error(`row ${index + 1} attempt must be a positive integer`);
  }
}

function pairKey(row) {
  return `${row.taskId}\u0000${row.attempt}`;
}

function displayPairKey(key) {
  const [taskId, attempt] = key.split('\u0000');
  return `taskId=${taskId} attempt=${attempt}`;
}

function sameValue(left, right) {
  return Object.is(left, right);
}

function validateMatchedInput(left, right, key) {
  const checks = [
    ['prompt', left.prompt, right.prompt],
    ['model', left.model, right.model],
    ['budgetUsd', left.budgetUsd, right.budgetUsd],
  ];
  const mismatches = checks
    .filter(([, leftValue, rightValue]) => !sameValue(leftValue, rightValue))
    .map(([field, leftValue, rightValue]) => `${field} direct=${JSON.stringify(leftValue)} invoker=${JSON.stringify(rightValue)}`);
  if (mismatches.length > 0) {
    throw new Error(`matched input mismatch for ${displayPairKey(key)}: ${mismatches.join(', ')}`);
  }
}

export function pairRows(rows) {
  const groups = new Map();
  rows.forEach((row, index) => {
    requireRowShape(row, index);
    const key = pairKey(row);
    if (!groups.has(key)) groups.set(key, new Map());
    const byCondition = groups.get(key);
    if (byCondition.has(row.condition)) {
      throw new Error(`duplicate ${row.condition} row for ${displayPairKey(key)}`);
    }
    byCondition.set(row.condition, row);
  });

  const pairs = [];
  const errors = [];
  for (const [key, byCondition] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const direct = byCondition.get(DIRECT_CONDITION);
    const invoker = byCondition.get(INVOKER_CONDITION);
    if (!direct || !invoker) {
      const missing = EXPECTED_CONDITIONS.filter((condition) => !byCondition.has(condition)).join(', ');
      errors.push(`unmatched pair for ${displayPairKey(key)}: missing ${missing}`);
      continue;
    }
    validateMatchedInput(direct, invoker, key);
    pairs.push({ key, taskId: direct.taskId, attempt: direct.attempt, direct, invoker });
  }
  if (errors.length > 0) {
    throw new Error(`paired result validation failed:\n  - ${errors.join('\n  - ')}`);
  }
  return pairs;
}

function passed(row) {
  if (typeof row.passed === 'boolean') return row.passed;
  return row.verdict === 'pass';
}

function verdict(row) {
  if (typeof row.verdict === 'string') return row.verdict;
  return passed(row) ? 'pass' : 'fail';
}

function retries(row) {
  const explicit = firstFinite(row, [['retries'], ['adapter', 'retries']]);
  if (explicit !== null) return explicit;
  return Math.max(0, row.attempt - 1);
}

function spend(row) {
  const value = firstFinite(row, [
    ['spendUsd'],
    ['costUsd'],
    ['estimatedCostUsd'],
    ['usage', 'spendUsd'],
    ['usage', 'costUsd'],
    ['usage', 'estimatedCostUsd'],
    ['adapter', 'spendUsd'],
    ['adapter', 'costUsd'],
    ['adapter', 'estimatedCostUsd'],
  ]);
  return value === null ? { value: 0, missing: true } : { value, missing: false };
}

function boolField(row, ...paths) {
  return paths.some((path) => {
    let current = row;
    for (const key of path) {
      if (current === null || typeof current !== 'object') return false;
      current = current[key];
    }
    return current === true;
  });
}

function hasInfrastructureFailure(row) {
  if (row.infrastructureFailure === true) return true;
  if (Array.isArray(row.infrastructureFailures) && row.infrastructureFailures.length > 0) return true;
  if (Array.isArray(row.adapter?.infrastructureFailures) && row.adapter.infrastructureFailures.length > 0) return true;
  return false;
}

function recovered(row) {
  return boolField(row, ['interruptionRecovered'], ['recoveredFromInterruption'], ['adapter', 'interruptionRecovered']);
}

function humanRescue(row) {
  return boolField(row, ['humanRescue'], ['adapter', 'humanRescue']);
}

function verifierErrored(row) {
  return verdict(row) === 'error' || row.verifier?.spawnError || row.verifier?.timedOut;
}

function classifyFailure(row) {
  if (passed(row)) return 'pass';
  if (humanRescue(row)) return 'human-intervention';
  if (hasInfrastructureFailure(row)) return 'infrastructure';
  if (verifierErrored(row)) return 'verifier';
  return 'agent';
}

function summarizeRows(rows) {
  const initial = {
    total: rows.length,
    verifierPasses: 0,
    verifierFailures: 0,
    verifierErrors: 0,
    durationMs: 0,
    spendUsd: 0,
    missingSpendRows: 0,
    budgetUsd: 0,
    missingBudgetRows: 0,
    retries: 0,
    humanRescue: 0,
    recovery: 0,
    infrastructureFailures: 0,
    agentFailures: 0,
    failureClasses: {
      pass: 0,
      infrastructure: 0,
      agent: 0,
      verifier: 0,
      'human-intervention': 0,
    },
  };

  for (const row of rows) {
    const rowPassed = passed(row);
    const rowVerdict = verdict(row);
    const rowSpend = spend(row);
    const rowBudget = finiteNumber(row.budgetUsd);
    const failureClass = classifyFailure(row);

    initial.verifierPasses += rowPassed ? 1 : 0;
    initial.verifierFailures += !rowPassed && rowVerdict !== 'error' ? 1 : 0;
    initial.verifierErrors += verifierErrored(row) ? 1 : 0;
    initial.durationMs += finiteNumber(row.durationMs) ?? 0;
    initial.spendUsd += rowSpend.value;
    initial.missingSpendRows += rowSpend.missing ? 1 : 0;
    initial.budgetUsd += rowBudget ?? 0;
    initial.missingBudgetRows += rowBudget === null ? 1 : 0;
    initial.retries += retries(row);
    initial.humanRescue += humanRescue(row) ? 1 : 0;
    initial.recovery += recovered(row) ? 1 : 0;
    initial.infrastructureFailures += hasInfrastructureFailure(row) && !recovered(row) ? 1 : 0;
    initial.agentFailures += failureClass === 'agent' ? 1 : 0;
    initial.failureClasses[failureClass] += 1;
  }

  return {
    ...initial,
    verifierPassRate: initial.total === 0 ? 0 : initial.verifierPasses / initial.total,
    averageDurationMs: initial.total === 0 ? 0 : initial.durationMs / initial.total,
  };
}

function pairOutcome(pair) {
  return {
    taskId: pair.taskId,
    attempt: pair.attempt,
    directPassed: passed(pair.direct),
    invokerPassed: passed(pair.invoker),
    durationDeltaMs: (finiteNumber(pair.invoker.durationMs) ?? 0) - (finiteNumber(pair.direct.durationMs) ?? 0),
    spendDeltaUsd: spend(pair.invoker).value - spend(pair.direct).value,
    retriesDelta: retries(pair.invoker) - retries(pair.direct),
    humanRescueDelta: (humanRescue(pair.invoker) ? 1 : 0) - (humanRescue(pair.direct) ? 1 : 0),
    recoveryDelta: (recovered(pair.invoker) ? 1 : 0) - (recovered(pair.direct) ? 1 : 0),
  };
}

function summarizeDeltas(direct, invoker) {
  return {
    verifierPassRate: invoker.verifierPassRate - direct.verifierPassRate,
    durationMs: invoker.durationMs - direct.durationMs,
    averageDurationMs: invoker.averageDurationMs - direct.averageDurationMs,
    spendUsd: invoker.spendUsd - direct.spendUsd,
    retries: invoker.retries - direct.retries,
    humanRescue: invoker.humanRescue - direct.humanRescue,
    recovery: invoker.recovery - direct.recovery,
    infrastructureFailures: invoker.infrastructureFailures - direct.infrastructureFailures,
    agentFailures: invoker.agentFailures - direct.agentFailures,
    verifierErrors: invoker.verifierErrors - direct.verifierErrors,
  };
}

export function harborDryRunRecords(report) {
  return report.pairs.map((pair) => ({
    externalKey: `local-e2e/${pair.taskId}/${pair.attempt}`,
    taskId: pair.taskId,
    attempt: pair.attempt,
    conditions: {
      [DIRECT_CONDITION]: {
        passed: passed(pair.direct),
        verdict: verdict(pair.direct),
        durationMs: finiteNumber(pair.direct.durationMs) ?? 0,
        spendUsd: spend(pair.direct).value,
        retries: retries(pair.direct),
        humanRescue: humanRescue(pair.direct),
        recovery: recovered(pair.direct),
        failureClass: classifyFailure(pair.direct),
      },
      [INVOKER_CONDITION]: {
        passed: passed(pair.invoker),
        verdict: verdict(pair.invoker),
        durationMs: finiteNumber(pair.invoker.durationMs) ?? 0,
        spendUsd: spend(pair.invoker).value,
        retries: retries(pair.invoker),
        humanRescue: humanRescue(pair.invoker),
        recovery: recovered(pair.invoker),
        failureClass: classifyFailure(pair.invoker),
      },
    },
  }));
}

export function buildReport(rows) {
  const pairs = pairRows(rows);
  const directRows = pairs.map((pair) => pair.direct);
  const invokerRows = pairs.map((pair) => pair.invoker);
  const conditions = {
    [DIRECT_CONDITION]: summarizeRows(directRows),
    [INVOKER_CONDITION]: summarizeRows(invokerRows),
  };
  return {
    schemaVersion: 1,
    rows: rows.length,
    pairCount: pairs.length,
    pairKey: 'taskId+attempt',
    conditions,
    deltas: summarizeDeltas(conditions[DIRECT_CONDITION], conditions[INVOKER_CONDITION]),
    pairOutcomes: pairs.map(pairOutcome),
    pairs,
    harborDryRun: {
      optIn: true,
      writes: false,
      docs: 'Run with --harbor-dry-run to print future importer records. This report performs no Harbor writes.',
    },
  };
}

function renderCondition(name, summary) {
  return [
    `- ${name}: verifier pass rate ${summary.verifierPasses}/${summary.total} (${formatPercent(summary.verifierPassRate)})`,
    `  duration total ${summary.durationMs}ms, average ${summary.averageDurationMs.toFixed(1)}ms`,
    `  spend ${formatUsd(summary.spendUsd)} (${summary.missingSpendRows} missing spend rows), budget ${formatUsd(summary.budgetUsd)} (${summary.missingBudgetRows} missing budget rows)`,
    `  retries ${summary.retries}, human rescue ${summary.humanRescue}, recovery ${summary.recovery}`,
    `  failures infrastructure ${summary.infrastructureFailures}, agent ${summary.agentFailures}, verifier errors ${summary.verifierErrors}`,
  ].join('\n');
}

export function renderTextReport(report, { harborDryRun = false } = {}) {
  const direct = report.conditions[DIRECT_CONDITION];
  const invoker = report.conditions[INVOKER_CONDITION];
  const lines = [
    'Evaluation paired comparison report',
    `Rows: ${report.rows}`,
    `Pairs: ${report.pairCount} (${report.pairKey})`,
    'Pair validation: one direct-agent and one invoker row per taskId + attempt; matched prompt, model, and budgetUsd.',
    '',
    'Metrics by condition',
    renderCondition(DIRECT_CONDITION, direct),
    renderCondition(INVOKER_CONDITION, invoker),
    '',
    'Outcome deltas (invoker - direct-agent)',
    `- verifier pass rate ${signedFixed(report.deltas.verifierPassRate * 100, 1, 'pp')}`,
    `- duration total ${signedNumber(report.deltas.durationMs, 'ms')}, average ${signedFixed(report.deltas.averageDurationMs, 1, 'ms')}`,
    `- spend ${signedUsd(report.deltas.spendUsd)}`,
    `- retries ${signedNumber(report.deltas.retries)}, human rescue ${signedNumber(report.deltas.humanRescue)}, recovery ${signedNumber(report.deltas.recovery)}`,
    `- failures infrastructure ${signedNumber(report.deltas.infrastructureFailures)}, agent ${signedNumber(report.deltas.agentFailures)}, verifier errors ${signedNumber(report.deltas.verifierErrors)}`,
    '',
    'Harbor dry-run mapping',
    '- Opt-in only: pass --harbor-dry-run to print records for a future importer.',
    '- No Harbor writes are performed by this report command.',
  ];

  if (harborDryRun) {
    lines.push('', JSON.stringify({
      harborDryRun: true,
      writes: false,
      records: harborDryRunRecords(report),
    }, null, 2));
  }
  return lines.join('\n');
}

function publicJsonReport(report, { harborDryRun = false } = {}) {
  const { pairs, ...safeReport } = report;
  return {
    ...safeReport,
    harborDryRun: {
      ...safeReport.harborDryRun,
      requested: harborDryRun,
      records: harborDryRun ? harborDryRunRecords(report) : [],
    },
  };
}

function parseArgs(argv) {
  const parsed = { resultsPaths: [], json: false, harborDryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--results') parsed.resultsPaths.push(next());
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--harbor-dry-run') parsed.harborDryRun = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown argument "${arg}"`);
    else parsed.resultsPaths.push(arg);
  }
  return parsed;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help || options.resultsPaths.length === 0) {
    console.error(USAGE);
    process.exitCode = options.help ? 0 : 1;
    return;
  }
  const rows = readResultFiles(options.resultsPaths);
  const report = buildReport(rows);
  const output = options.json
    ? JSON.stringify(publicJsonReport(report, { harborDryRun: options.harborDryRun }), null, 2)
    : renderTextReport(report, { harborDryRun: options.harborDryRun });
  console.log(output);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`e2e-eval-report: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
