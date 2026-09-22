#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  MAX_PROCESS_BUFFER_BYTES,
  parseManifest,
  runTask,
} from './e2e-eval-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const DIRECT_CONDITION = 'direct-agent';
export const DEFAULT_MAX_RETRIES = 1;
export const ADAPTER_ATTEMPTS_FILE = '.e2e-eval-adapter-attempts.json';

const INTERRUPTED_EXIT_CODES = new Set([124, 130, 137, 143]);
const INTERRUPTED_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL']);

const USAGE = [
  'usage: e2e-eval-direct-agent.mjs --manifest <path> [--task <id>]... [--results <path>]',
  '                                  [--model <id>] [--budget-usd <n>] [--max-retries <n>]',
  '                                  [--run-id <id>] [--keep]',
  '       e2e-eval-direct-agent.mjs --self-test',
  '',
  'Runs eval tasks through the direct-agent condition. The task solver command is',
  'wrapped with bounded retry metadata, then the existing independent verifier',
  'grades the final disposable workspace state.',
].join('\n');

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function truncateOutput(value) {
  const text = typeof value === 'string' ? value : '';
  return text.length > 8_000 ? `${text.slice(0, 8_000)}...[truncated]` : text;
}

function classifyInfrastructureFailure(attempt) {
  if (!attempt) return null;
  if (attempt.spawnError) return { kind: 'spawn-error', detail: attempt.spawnError };
  if (attempt.timedOut) return { kind: 'timeout', detail: `${attempt.timeoutMs}ms` };
  if (attempt.signal && INTERRUPTED_SIGNALS.has(attempt.signal)) return { kind: 'interrupted', detail: attempt.signal };
  if (INTERRUPTED_EXIT_CODES.has(attempt.exitCode)) return { kind: 'interrupted', detail: `exit ${attempt.exitCode}` };
  return null;
}

function isRetriableInfrastructureFailure(attempt) {
  return classifyInfrastructureFailure(attempt) !== null;
}

function runSolverAttempt(argv, timeoutMs) {
  const startedAt = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    maxBuffer: MAX_PROCESS_BUFFER_BYTES,
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = result.error?.code === 'ETIMEDOUT'
    || (result.signal === 'SIGKILL' && durationMs + 1 >= timeoutMs);
  return {
    command: argv,
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    timedOut,
    timeoutMs,
    spawnError: result.error && !timedOut ? `${result.error.code ?? 'ERROR'}: ${result.error.message}` : null,
    durationMs,
    stdout: truncateOutput(result.stdout),
    stderr: truncateOutput(result.stderr),
  };
}

export function executeSolverCommand(payload) {
  const spec = typeof payload === 'string' ? decodeJson(payload) : payload;
  const maxRetries = Number.isInteger(spec.maxRetries) && spec.maxRetries >= 0 ? spec.maxRetries : DEFAULT_MAX_RETRIES;
  const timeoutMs = Number.isInteger(spec.timeoutMs) && spec.timeoutMs > 0 ? spec.timeoutMs : 600_000;
  const deadline = Date.now() + timeoutMs;
  const attempts = [];
  let finalExitCode = 1;

  for (let index = 0; index <= maxRetries; index += 1) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const attempt = runSolverAttempt(spec.run, remainingMs);
    attempt.attempt = index + 1;
    attempt.infrastructureFailure = classifyInfrastructureFailure(attempt);
    attempts.push(attempt);

    finalExitCode = attempt.spawnError ? 127 : (attempt.exitCode ?? (attempt.timedOut ? 124 : 1));
    if (!isRetriableInfrastructureFailure(attempt)) break;
    if (Date.now() >= deadline) break;
  }

  const attemptsPath = process.env.E2E_EVAL_ATTEMPTS_PATH || join(process.cwd(), ADAPTER_ATTEMPTS_FILE);
  writeFileSync(attemptsPath, `${JSON.stringify({
    condition: spec.condition ?? DIRECT_CONDITION,
    maxRetries,
    attempts,
  }, null, 2)}\n`);

  const finalAttempt = attempts.at(-1);
  if (finalAttempt?.stdout) process.stdout.write(finalAttempt.stdout);
  if (finalAttempt?.stderr) process.stderr.write(finalAttempt.stderr);
  return finalExitCode;
}

export function directSolveRun(task, options = {}) {
  const attemptsPath = join(process.env.EVAL_WORKSPACE || '.', ADAPTER_ATTEMPTS_FILE);
  return {
    run: [
      process.execPath,
      fileURLToPath(import.meta.url),
      '--execute-command',
      encodeJson({
        condition: options.condition ?? DIRECT_CONDITION,
        run: task.solve.run,
        timeoutMs: task.solve.timeoutMs,
        maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      }),
    ],
    timeoutMs: task.solve.timeoutMs,
    env: {
      ...task.solve.env,
      E2E_EVAL_ATTEMPTS_PATH: attemptsPath,
    },
  };
}

function readAttempts(workspace) {
  const attemptsPath = join(workspace, ADAPTER_ATTEMPTS_FILE);
  if (!existsSync(attemptsPath)) return { attempts: [], metadata: null };
  const metadata = JSON.parse(readFileSync(attemptsPath, 'utf8'));
  return {
    attempts: Array.isArray(metadata.attempts) ? metadata.attempts : [],
    metadata,
  };
}

export function enrichAdapterRow(row, { condition, attempts, maxRetries }) {
  const infrastructureFailures = attempts
    .map((attempt) => ({ attempt: attempt.attempt, failure: classifyInfrastructureFailure(attempt) }))
    .filter((entry) => entry.failure !== null);
  const attempt = attempts.length || 1;
  const passed = row.verdict === 'pass';
  return {
    ...row,
    condition,
    attempt,
    passed,
    retries: Math.max(0, attempt - 1),
    maxRetries,
    humanRescue: false,
    infrastructureFailure: infrastructureFailures.length > 0 && !passed,
    infrastructureFailures,
    interruptionRecovered: infrastructureFailures.length > 0 && passed,
    verifierOutput: {
      stdout: row.verifier.stdout,
      stderr: row.verifier.stderr,
    },
    adapter: {
      condition,
      attempt,
      retries: Math.max(0, attempt - 1),
      maxRetries,
      humanRescue: false,
      infrastructureFailures,
      sandbox: 'disposable-workspace',
    },
  };
}

function selectTasks(manifest, taskIds) {
  if (!taskIds || taskIds.length === 0) return manifest.tasks;
  const selected = manifest.tasks.filter((task) => taskIds.includes(task.id));
  if (selected.length === 0) throw new Error(`no manifest task matched ${JSON.stringify(taskIds)}`);
  return selected;
}

export function runDirectManifest(manifest, options = {}) {
  return runConditionManifest(manifest, {
    ...options,
    condition: options.condition ?? DIRECT_CONDITION,
    adaptSolve: options.adaptSolve ?? directSolveRun,
  });
}

export function runConditionManifest(manifest, options = {}) {
  const runId = options.runId ?? `${options.condition ?? DIRECT_CONDITION}-${Date.now()}-${process.pid}`;
  const condition = options.condition ?? DIRECT_CONDITION;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const resultsPath = options.resultsPath ?? join(tmpdir(), `invoker-e2e-eval-${condition}-${runId}.jsonl`);
  mkdirSync(dirname(resolve(resultsPath)), { recursive: true });
  writeFileSync(resultsPath, '');

  const rows = [];
  for (const task of selectTasks(manifest, options.taskIds)) {
    const taskForCondition = {
      ...task,
      model: options.model ?? task.model,
      modelSource: options.model ? 'cli' : task.modelSource,
      budgetUsd: options.budgetUsd ?? task.budgetUsd,
      budgetSource: options.budgetUsd === undefined ? task.budgetSource : 'cli',
    };
    const adapted = {
      ...taskForCondition,
      solve: options.adaptSolve(taskForCondition, { condition, maxRetries }),
    };
    const rawRow = runTask(adapted, { runId, keep: true });
    const { attempts } = readAttempts(rawRow.paths.workspace);
    const row = enrichAdapterRow(rawRow, { condition, attempts, maxRetries });
    appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
    rows.push(row);
    if (!options.quiet) {
      const firstVerifierLine = (row.verifier.stdout || row.verifier.stderr || '').split('\n').find((line) => line.trim()) ?? '';
      console.log(
        `[${condition}:${row.verdict}] ${row.taskId} attempt=${row.attempt} passed=${row.passed} `
        + `retries=${row.retries} verifier="${firstVerifierLine.trim()}"`,
      );
    }
    if (!options.keep) rmSync(rawRow.paths.root, { recursive: true, force: true });
  }

  return {
    runId,
    condition,
    resultsPath,
    rows,
    total: rows.length,
    passed: rows.filter((row) => row.passed).length,
    failed: rows.filter((row) => !row.passed).length,
  };
}

function nodeRun(source) {
  return [process.execPath, '-e', source];
}

function verifyAnswer(expected) {
  return [
    "const fs = require('node:fs');",
    "const actual = fs.existsSync('answer.txt') ? fs.readFileSync('answer.txt', 'utf8').trim() : '<missing>';",
    `if (actual !== ${JSON.stringify(expected)}) { console.error('verifier: expected ${expected}, found ' + JSON.stringify(actual)); process.exit(1); }`,
    `console.log('verifier: answer.txt === ${expected}');`,
  ].join('\n');
}

export function adapterSmokeManifest() {
  const recoverySolver = [
    "const fs = require('node:fs');",
    "if (!fs.existsSync('interrupted.once')) {",
    "  fs.writeFileSync('interrupted.once', 'first attempt interrupted\\n');",
    "  console.error('solver: simulated interruption');",
    "  process.exit(143);",
    "}",
    "fs.writeFileSync('answer.txt', 'recovered\\n');",
    "console.log('solver: recovered on retry');",
  ].join('\n');
  return {
    version: 1,
    defaults: { model: 'gpt-5-codex', budgetUsd: 0.05, timeoutMs: 60_000 },
    tasks: [
      {
        id: 'direct-write-pass',
        prompt: 'Write alpha into answer.txt.',
        fixture: { files: { 'answer.txt': 'todo\n' } },
        solve: { run: nodeRun("require('node:fs').writeFileSync('answer.txt', 'alpha\\n'); console.log('solver: wrote alpha');") },
        verify: { run: nodeRun(verifyAnswer('alpha')), timeoutMs: 30_000 },
      },
      {
        id: 'claim-only-fails',
        prompt: 'Write beta into answer.txt.',
        fixture: { files: { 'answer.txt': 'todo\n' } },
        solve: { run: nodeRun("console.log('solver: claimed success without editing');") },
        verify: { run: nodeRun(verifyAnswer('beta')), timeoutMs: 30_000 },
      },
      {
        id: 'interruption-recovers',
        prompt: 'Recover from one interrupted attempt, then write recovered into answer.txt.',
        fixture: { files: { 'answer.txt': 'todo\n' } },
        solve: { run: nodeRun(recoverySolver) },
        verify: { run: nodeRun(verifyAnswer('recovered')), timeoutMs: 30_000 },
      },
    ],
  };
}

function checkoutSnapshot() {
  const status = spawnSync('git', ['status', '--porcelain=v1'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: MAX_PROCESS_BUFFER_BYTES,
  });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: MAX_PROCESS_BUFFER_BYTES,
  });
  return `${head.stdout}\n${status.stdout}`;
}

export function assertAdapterSmokeRows(rows, expectedCondition) {
  const failures = [];
  const check = (label, condition, detail = '') => {
    if (!condition) failures.push(detail ? `${label} (${detail})` : label);
  };
  check(`${expectedCondition} emitted three rows`, rows.length === 3, `got ${rows.length}`);
  const byId = new Map(rows.map((row) => [row.taskId, row]));
  check('direct-write-pass passed', byId.get('direct-write-pass')?.passed === true);
  check('claim-only-fails failed by verifier', byId.get('claim-only-fails')?.passed === false);
  check('interruption-recovers passed', byId.get('interruption-recovers')?.passed === true);
  check('interruption recovery recorded one retry', byId.get('interruption-recovers')?.retries === 1);
  check('interruption recovery classified separately', byId.get('interruption-recovers')?.interruptionRecovered === true);
  for (const row of rows) {
    check(`${row.taskId} condition`, row.condition === expectedCondition, row.condition);
    check(`${row.taskId} attempt present`, Number.isInteger(row.attempt) && row.attempt >= 1);
    check(`${row.taskId} passed boolean`, typeof row.passed === 'boolean');
    check(`${row.taskId} duration present`, Number.isInteger(row.durationMs) && row.durationMs >= 0);
    check(`${row.taskId} verifier stdout present`, typeof row.verifierOutput.stdout === 'string');
    check(`${row.taskId} model preserved`, row.model === 'gpt-5-codex', row.model);
    check(`${row.taskId} budget preserved`, row.budgetUsd === 0.05, String(row.budgetUsd));
    const rootPath = existsSync(row.paths.root) ? realpathSync(row.paths.root) : row.paths.root;
    check(`${row.taskId} disposable root`, rootPath.startsWith(realpathSync(tmpdir())));
  }
  if (failures.length > 0) {
    throw new Error(`adapter smoke assertions failed:\n  - ${failures.join('\n  - ')}`);
  }
}

export function selfTest() {
  const before = checkoutSnapshot();
  const manifest = parseManifest(adapterSmokeManifest(), 'direct-agent-self-test');
  const workDir = mkdtempSync(join(tmpdir(), 'invoker-e2e-eval-direct-selftest-'));
  try {
    const resultsPath = join(workDir, 'direct.jsonl');
    const summary = runDirectManifest(manifest, {
      runId: 'direct-agent-self-test',
      resultsPath,
      quiet: true,
      maxRetries: DEFAULT_MAX_RETRIES,
    });
    assertAdapterSmokeRows(summary.rows, DIRECT_CONDITION);
    const fileRows = readFileSync(resultsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assertAdapterSmokeRows(fileRows, DIRECT_CONDITION);
    const after = checkoutSnapshot();
    if (before !== after) throw new Error('source checkout changed during direct-agent self-test');
    console.log(`PASS e2e-eval-direct-agent self-test: ${summary.rows.length} ${DIRECT_CONDITION} rows with verifier output`);
    return true;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const parsed = { taskIds: [], maxRetries: DEFAULT_MAX_RETRIES, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--execute-command') parsed.executeCommand = next();
    else if (arg === '--self-test') parsed.selfTest = true;
    else if (arg === '--manifest') parsed.manifestPath = next();
    else if (arg === '--results') parsed.resultsPath = next();
    else if (arg === '--task') parsed.taskIds.push(next());
    else if (arg === '--model') parsed.model = next();
    else if (arg === '--budget-usd') parsed.budgetUsd = Number(next());
    else if (arg === '--run-id') parsed.runId = next();
    else if (arg === '--max-retries') parsed.maxRetries = Number.parseInt(next(), 10);
    else if (arg === '--keep') parsed.keep = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (!Number.isInteger(parsed.maxRetries) || parsed.maxRetries < 0) {
    throw new Error('--max-retries must be an integer >= 0');
  }
  if (parsed.budgetUsd !== undefined && (!Number.isFinite(parsed.budgetUsd) || parsed.budgetUsd < 0)) {
    throw new Error('--budget-usd must be a finite number >= 0');
  }
  return parsed;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.executeCommand) {
    process.exitCode = executeSolverCommand(options.executeCommand);
    return;
  }
  if (options.help || (!options.selfTest && !options.manifestPath)) {
    console.error(USAGE);
    process.exitCode = options.help ? 0 : 1;
    return;
  }
  if (options.selfTest) {
    selfTest();
    return;
  }
  const manifestPath = resolve(options.manifestPath);
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'), manifestPath);
  const summary = runDirectManifest(manifest, options);
  console.log(`e2e-eval-direct-agent: ${summary.passed}/${summary.total} passed, results ${summary.resultsPath}`);
  if (summary.failed > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`e2e-eval-direct-agent: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
