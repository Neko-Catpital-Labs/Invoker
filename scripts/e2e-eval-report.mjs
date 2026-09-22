#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REPORT_SCHEMA_VERSION = 1;
export const DIRECT_CONDITION = 'direct-agent';
export const INVOKER_CONDITION = 'invoker';
export const CONDITION_ORDER = [DIRECT_CONDITION, INVOKER_CONDITION];

const SELF_PATH = fileURLToPath(import.meta.url);

export const HARBOR_DRY_RUN_DOCS = [
  'Harbor export is opt-in and dry-run only in this local report.',
  'Use --json or --harbor-dry-run to inspect the field mapping; this script never uploads, publishes, merges, or mutates source state.',
  'Importer contract: one mapped record per paired task attempt, keyed by task_id, attempt, direct_condition, and invoker_condition.',
].join(' ');

export const HARBOR_MAPPING = [
  { harborField: 'task_id', source: 'pair.taskId' },
  { harborField: 'attempt', source: 'pair.attempt' },
  { harborField: 'direct_condition', source: 'pair.conditions.direct-agent.condition' },
  { harborField: 'invoker_condition', source: 'pair.conditions.invoker.condition' },
  { harborField: 'direct_verifier_passed', source: 'pair.conditions.direct-agent.passed' },
  { harborField: 'invoker_verifier_passed', source: 'pair.conditions.invoker.passed' },
  { harborField: 'direct_duration_ms', source: 'pair.conditions.direct-agent.durationMs' },
  { harborField: 'invoker_duration_ms', source: 'pair.conditions.invoker.durationMs' },
  { harborField: 'direct_spend_usd', source: 'pair.conditions.direct-agent.spendUsd.value' },
  { harborField: 'invoker_spend_usd', source: 'pair.conditions.invoker.spendUsd.value' },
  { harborField: 'direct_retries', source: 'pair.conditions.direct-agent.retries' },
  { harborField: 'invoker_retries', source: 'pair.conditions.invoker.retries' },
  { harborField: 'direct_human_rescue', source: 'pair.conditions.direct-agent.humanRescue' },
  { harborField: 'invoker_human_rescue', source: 'pair.conditions.invoker.humanRescue' },
  { harborField: 'direct_recovery_kind', source: 'pair.conditions.direct-agent.recovery.kind' },
  { harborField: 'invoker_recovery_kind', source: 'pair.conditions.invoker.recovery.kind' },
  { harborField: 'direct_failure_class', source: 'pair.conditions.direct-agent.failureClass' },
  { harborField: 'invoker_failure_class', source: 'pair.conditions.invoker.failureClass' },
];

const USAGE = [
  'usage: e2e-eval-report.mjs --results <results.jsonl> [--results <results.jsonl> ...] [--json] [--harbor-dry-run]',
  '       e2e-eval-report.mjs <results.jsonl> [results.jsonl ...]',
  '',
  'Reads adapter JSONL result rows, validates exact direct-agent/invoker pairs',
  'by task id and attempt, then reports verifier pass rate, duration, spend,',
  'retries, human rescue, recovery, and failure classes. Reporting is read-only.',
  '',
  `Harbor dry-run: ${HARBOR_DRY_RUN_DOCS}`,
  '',
  'Exit codes: 0 report produced, 1 unmatched or invalid result rows, 2 usage error.',
].join('\n');

export class EvalReportError extends Error {}

function asFiniteNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function rate(count, total) {
  return total === 0 ? 0 : round(count / total);
}

function pairKey(row) {
  return `${row.taskId}\u0000${row.attempt}`;
}

function parseJsonl(text, source) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('line is not a JSON object');
      }
      rows.push({ ...parsed, __source: source, __line: index + 1 });
    } catch (error) {
      throw new EvalReportError(`${source}:${index + 1}: invalid JSONL row: ${error.message}`);
    }
  }
  return rows;
}

export function readResultFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new EvalReportError('at least one --results path is required');
  }
  return paths.flatMap((resultPath) => {
    const resolved = path.resolve(resultPath);
    if (!existsSync(resolved)) {
      throw new EvalReportError(`results file not found: ${resolved}`);
    }
    return parseJsonl(readFileSync(resolved, 'utf8'), resolved);
  });
}

function validateRowShape(row) {
  const where = `${row.__source ?? '<inline>'}:${row.__line ?? '?'}`;
  if (typeof row.taskId !== 'string' || row.taskId.trim() === '') {
    throw new EvalReportError(`${where}: row must include a non-empty taskId`);
  }
  if (!CONDITION_ORDER.includes(row.condition)) {
    throw new EvalReportError(`${where}: unsupported condition ${JSON.stringify(row.condition)} (expected ${CONDITION_ORDER.join(' or ')})`);
  }
  if (!Number.isInteger(row.attempt) || row.attempt <= 0) {
    throw new EvalReportError(`${where}: row ${row.taskId}/${row.condition} must include a positive integer attempt`);
  }
  if (typeof row.passed !== 'boolean') {
    throw new EvalReportError(`${where}: row ${row.taskId}/${row.condition} must include boolean passed`);
  }
}

function assertMatchedInputs(taskId, attempt, rows) {
  const comparableFields = ['model', 'budgetUsd', 'solverTimeoutMs', 'verifierTimeoutMs'];
  for (const field of comparableFields) {
    const values = new Set(rows.map((row) => JSON.stringify(row[field] ?? null)));
    if (values.size > 1) {
      throw new EvalReportError(`matched input mismatch for ${taskId} attempt ${attempt}: field ${field} differs across conditions`);
    }
  }
}

export function validatePairs(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new EvalReportError('no result rows found');
  }
  const groups = new Map();
  for (const row of rows) {
    validateRowShape(row);
    const key = pairKey(row);
    const group = groups.get(key) ?? [];
    if (group.some((existing) => existing.condition === row.condition)) {
      throw new EvalReportError(`duplicate row for task ${row.taskId} attempt ${row.attempt} condition ${row.condition}`);
    }
    group.push(row);
    groups.set(key, group);
  }

  const pairs = [];
  for (const group of groups.values()) {
    const first = group[0];
    const missing = CONDITION_ORDER.filter((condition) => !group.some((row) => row.condition === condition));
    if (missing.length > 0 || group.length !== CONDITION_ORDER.length) {
      throw new EvalReportError(`unmatched row set for task ${first.taskId} attempt ${first.attempt}: missing condition(s) ${missing.join(', ') || '<none>'}`);
    }
    assertMatchedInputs(first.taskId, first.attempt, group);
    pairs.push({
      taskId: first.taskId,
      attempt: first.attempt,
      rows: Object.fromEntries(group.map((row) => [row.condition, row])),
    });
  }

  return pairs.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.attempt - b.attempt);
}

export function spendForRow(row) {
  const candidates = [
    ['spendUsd', row.spendUsd],
    ['costUsd', row.costUsd],
    ['totalSpendUsd', row.totalSpendUsd],
    ['usage.totalSpendUsd', row.usage?.totalSpendUsd],
    ['usage.totalCostUsd', row.usage?.totalCostUsd],
    ['budgetUsd-fallback', row.budgetUsd],
  ];
  for (const [source, value] of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return { value, source };
    }
  }
  return { value: 0, source: 'missing' };
}

function recoveryForRow(row) {
  const raw = row.interruptionRecovery;
  if (!raw || typeof raw !== 'object') {
    return { kind: 'none', recoveredByVerifier: false, verifierExitCode: row.verifier?.exitCode ?? null };
  }
  return {
    kind: typeof raw.kind === 'string' && raw.kind.trim() !== '' ? raw.kind : 'none',
    recoveredByVerifier: raw.recoveredByVerifier === true,
    verifierExitCode: raw.verifierExitCode ?? row.verifier?.exitCode ?? null,
  };
}

function failureClassForRow(row) {
  if (row.passed === true) return 'pass';
  if (row.humanRescue === true) return 'human-intervention';
  if (row.infrastructureFailure) return 'infrastructure';
  if (row.verifier?.spawnError || row.verifier?.timedOut) return 'verifier';
  const recovery = recoveryForRow(row);
  if (recovery.kind !== 'none' && recovery.recoveredByVerifier !== true) return 'interrupted';
  return 'agent';
}

function increment(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

function rowSummary(row) {
  const spend = spendForRow(row);
  const recovery = recoveryForRow(row);
  return {
    condition: row.condition,
    passed: row.passed,
    durationMs: asFiniteNumber(row.durationMs),
    spendUsd: { value: spend.value, source: spend.source },
    budgetUsd: asFiniteNumber(row.budgetUsd),
    retries: asFiniteNumber(row.retries),
    humanRescue: row.humanRescue === true,
    recovery,
    failureClass: failureClassForRow(row),
    workflowId: row.invoker?.workflowId ?? null,
    invokerTaskId: row.invoker?.taskId ?? null,
    invokerAttemptId: row.invoker?.attemptId ?? null,
  };
}

function conditionMetrics(rows) {
  const summaryRows = rows.map(rowSummary);
  const total = summaryRows.length;
  const passed = summaryRows.filter((row) => row.passed).length;
  const durationTotal = summaryRows.reduce((sum, row) => sum + row.durationMs, 0);
  const spendTotal = summaryRows.reduce((sum, row) => sum + row.spendUsd.value, 0);
  const budgetTotal = summaryRows.reduce((sum, row) => sum + row.budgetUsd, 0);
  const retriesTotal = summaryRows.reduce((sum, row) => sum + row.retries, 0);
  const humanRescueCount = summaryRows.filter((row) => row.humanRescue).length;
  const spendSources = {};
  const recoveryByKind = {};
  const failureClasses = {};
  let recoveredByVerifier = 0;
  let unrecoveredInterruptions = 0;

  for (const row of summaryRows) {
    increment(spendSources, row.spendUsd.source);
    increment(recoveryByKind, row.recovery.kind);
    increment(failureClasses, row.failureClass);
    if (row.recovery.recoveredByVerifier) recoveredByVerifier += 1;
    if (row.recovery.kind !== 'none' && !row.recovery.recoveredByVerifier) unrecoveredInterruptions += 1;
  }

  return {
    rows: total,
    verifier: { passed, total, passRate: rate(passed, total) },
    durationMs: { total: durationTotal, average: round(durationTotal / Math.max(total, 1), 3) },
    spendUsd: { total: round(spendTotal), average: round(spendTotal / Math.max(total, 1)), sourceCounts: spendSources },
    budgetUsd: { total: round(budgetTotal), average: round(budgetTotal / Math.max(total, 1)) },
    retries: { total: retriesTotal, average: round(retriesTotal / Math.max(total, 1)) },
    humanRescue: { count: humanRescueCount, rate: rate(humanRescueCount, total) },
    recovery: {
      recoveredByVerifier,
      unrecoveredInterruptions,
      byKind: recoveryByKind,
    },
    failures: failureClasses,
  };
}

function pairSummary(pair) {
  const direct = rowSummary(pair.rows[DIRECT_CONDITION]);
  const invoker = rowSummary(pair.rows[INVOKER_CONDITION]);
  return {
    taskId: pair.taskId,
    attempt: pair.attempt,
    conditions: {
      [DIRECT_CONDITION]: direct,
      [INVOKER_CONDITION]: invoker,
    },
    deltas: {
      invokerMinusDirect: {
        passed: Number(invoker.passed) - Number(direct.passed),
        durationMs: invoker.durationMs - direct.durationMs,
        spendUsd: round(invoker.spendUsd.value - direct.spendUsd.value),
        retries: invoker.retries - direct.retries,
        humanRescue: Number(invoker.humanRescue) - Number(direct.humanRescue),
      },
    },
  };
}

function deltaMetrics(reportPairs) {
  const deltas = reportPairs.map((pair) => pair.deltas.invokerMinusDirect);
  const total = deltas.length;
  const sums = deltas.reduce((acc, delta) => ({
    passed: acc.passed + delta.passed,
    durationMs: acc.durationMs + delta.durationMs,
    spendUsd: acc.spendUsd + delta.spendUsd,
    retries: acc.retries + delta.retries,
    humanRescue: acc.humanRescue + delta.humanRescue,
  }), { passed: 0, durationMs: 0, spendUsd: 0, retries: 0, humanRescue: 0 });
  return {
    invokerMinusDirect: {
      passCount: sums.passed,
      passRateDelta: rate(sums.passed, total),
      durationMs: { total: sums.durationMs, average: round(sums.durationMs / Math.max(total, 1), 3) },
      spendUsd: { total: round(sums.spendUsd), average: round(sums.spendUsd / Math.max(total, 1)) },
      retries: { total: sums.retries, average: round(sums.retries / Math.max(total, 1)) },
      humanRescue: { count: sums.humanRescue, rate: rate(sums.humanRescue, total) },
    },
  };
}

export function buildReport(rows, options = {}) {
  const pairs = validatePairs(rows);
  const reportPairs = pairs.map(pairSummary);
  const rowsByCondition = Object.fromEntries(CONDITION_ORDER.map((condition) => [
    condition,
    pairs.map((pair) => pair.rows[condition]),
  ]));
  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sources: options.sources ?? [...new Set(rows.map((row) => row.__source).filter(Boolean))],
    pairCount: pairs.length,
    conditionOrder: CONDITION_ORDER,
    conditions: Object.fromEntries(CONDITION_ORDER.map((condition) => [
      condition,
      conditionMetrics(rowsByCondition[condition]),
    ])),
    deltas: deltaMetrics(reportPairs),
    pairs: reportPairs,
    harbor: {
      optIn: true,
      dryRunDocs: HARBOR_DRY_RUN_DOCS,
      mapping: HARBOR_MAPPING,
    },
  };
}

function formatPercent(value) {
  return `${round(value * 100, 2)}%`;
}

function formatUsd(value) {
  return `$${round(value, 4).toFixed(4)}`;
}

function formatCondition(condition, metrics) {
  return [
    `${condition}:`,
    `  Verifier pass rate: ${metrics.verifier.passed}/${metrics.verifier.total} (${formatPercent(metrics.verifier.passRate)})`,
    `  Duration: total ${metrics.durationMs.total}ms, avg ${metrics.durationMs.average}ms`,
    `  Spend: total ${formatUsd(metrics.spendUsd.total)}, avg ${formatUsd(metrics.spendUsd.average)}; sources ${JSON.stringify(metrics.spendUsd.sourceCounts)}`,
    `  Budget: total ${formatUsd(metrics.budgetUsd.total)}, avg ${formatUsd(metrics.budgetUsd.average)}`,
    `  Retries: total ${metrics.retries.total}, avg ${metrics.retries.average}`,
    `  Human rescue: ${metrics.humanRescue.count}/${metrics.rows} (${formatPercent(metrics.humanRescue.rate)})`,
    `  Recovery: recoveredByVerifier=${metrics.recovery.recoveredByVerifier}, unrecovered=${metrics.recovery.unrecoveredInterruptions}, byKind=${JSON.stringify(metrics.recovery.byKind)}`,
    `  Failure classes: ${JSON.stringify(metrics.failures)}`,
  ].join('\n');
}

export function formatReport(report, options = {}) {
  const lines = [
    `E2E eval paired report: ${report.pairCount} paired task attempt(s)`,
    formatCondition(DIRECT_CONDITION, report.conditions[DIRECT_CONDITION]),
    formatCondition(INVOKER_CONDITION, report.conditions[INVOKER_CONDITION]),
    'Invoker minus direct:',
    `  Pass count delta: ${report.deltas.invokerMinusDirect.passCount}`,
    `  Duration delta: total ${report.deltas.invokerMinusDirect.durationMs.total}ms, avg ${report.deltas.invokerMinusDirect.durationMs.average}ms`,
    `  Spend delta: total ${formatUsd(report.deltas.invokerMinusDirect.spendUsd.total)}, avg ${formatUsd(report.deltas.invokerMinusDirect.spendUsd.average)}`,
    `  Retry delta: total ${report.deltas.invokerMinusDirect.retries.total}, avg ${report.deltas.invokerMinusDirect.retries.average}`,
    `  Human rescue delta: ${report.deltas.invokerMinusDirect.humanRescue.count}`,
    `Harbor dry-run: ${HARBOR_DRY_RUN_DOCS}`,
  ];
  if (options.harborDryRun === true) {
    lines.push('Harbor mapping:');
    for (const entry of HARBOR_MAPPING) lines.push(`  ${entry.harborField} <- ${entry.source}`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseArgs(argv) {
  const parsed = { resultPaths: [], json: false, harborDryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--results') {
      parsed.resultPaths.push(argv[index + 1] ?? '');
      index += 1;
    } else if (arg.startsWith('--results=')) {
      parsed.resultPaths.push(arg.slice('--results='.length));
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--harbor-dry-run') {
      parsed.harborDryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg.startsWith('-')) {
      throw new EvalReportError(`unknown argument: ${arg}`);
    } else {
      parsed.resultPaths.push(arg);
    }
  }
  parsed.resultPaths = parsed.resultPaths.filter((value) => value.trim() !== '');
  return parsed;
}

function runCli(parsed) {
  const rows = readResultFiles(parsed.resultPaths);
  const report = buildReport(rows, { sources: parsed.resultPaths.map((resultPath) => path.resolve(resultPath)) });
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(formatReport(report, { harborDryRun: parsed.harborDryRun }));
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  let exitCode = 0;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(USAGE);
    } else if (parsed.resultPaths.length === 0) {
      console.error(USAGE);
      exitCode = 2;
    } else {
      exitCode = runCli(parsed);
    }
  } catch (error) {
    console.error(`e2e-eval-report: ${error.message}`);
    exitCode = error instanceof EvalReportError ? 1 : 2;
  }
  process.exitCode = exitCode;
}
