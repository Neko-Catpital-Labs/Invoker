#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, '..');
export const MANIFEST_SCHEMA_VERSION = 1;
export const RESULT_SCHEMA_VERSION = 1;
export const DEFAULT_SOLVER_TIMEOUT_MS = 900_000;
export const DEFAULT_VERIFIER_TIMEOUT_MS = 120_000;
export const MAX_CAPTURED_OUTPUT = 8_000;
export const GRADE_SOURCE = 'verifier-exit-code';

const USAGE = [
  'usage: e2e-eval-runner.mjs --manifest <path> [--task <id>] [--out <results.jsonl>] [--keep]',
  '       e2e-eval-runner.mjs --self-test',
  '       e2e-eval-runner.mjs --print-schema',
  '',
  'Runs each manifest task inside a disposable fixture directory, then grades the',
  'final state with an independent verifier command. The solver exit status, and',
  'any Invoker workflow/task status, are recorded but never used to decide pass or',
  'fail: only the verifier exit code grades a task.',
  '',
  'Exit codes: 0 every task passed, 1 at least one task failed, 2 usage or manifest error.',
].join('\n');

export class EvalManifestError extends Error {}

function truncate(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= MAX_CAPTURED_OUTPUT) return value;
  return `${value.slice(0, MAX_CAPTURED_OUTPUT)}\n[truncated ${value.length - MAX_CAPTURED_OUTPUT} bytes]`;
}

export function assertSafeRelativePath(candidate, label) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new EvalManifestError(`${label}: file path must be a non-empty string`);
  }
  if (path.isAbsolute(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate)) {
    throw new EvalManifestError(`${label}: file path must be relative, got "${candidate}"`);
  }
  const segments = candidate.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) {
    throw new EvalManifestError(`${label}: file path must not escape the fixture, got "${candidate}"`);
  }
  return candidate;
}

export function assertOutsideRepoCheckout(candidate, label) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(REPO_ROOT, resolved);
  const insideRepo = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (insideRepo) {
    throw new EvalManifestError(`${label}: refusing to write inside the source checkout (${resolved})`);
  }
  return resolved;
}

function requirePositiveInteger(value, label, fallback) {
  const resolved = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new EvalManifestError(`${label}: expected a positive integer number of milliseconds, got ${JSON.stringify(value)}`);
  }
  return resolved;
}

function normalizeFiles(rawFiles, label) {
  if (rawFiles === undefined || rawFiles === null) return {};
  if (typeof rawFiles !== 'object' || Array.isArray(rawFiles)) {
    throw new EvalManifestError(`${label}: files must be an object mapping relative paths to file contents`);
  }
  const normalized = {};
  for (const [filePath, contents] of Object.entries(rawFiles)) {
    assertSafeRelativePath(filePath, label);
    if (typeof contents !== 'string') {
      throw new EvalManifestError(`${label}: contents of "${filePath}" must be a string`);
    }
    normalized[filePath] = contents;
  }
  return normalized;
}

function normalizeCommand(rawCommand, label) {
  if (!rawCommand || typeof rawCommand !== 'object' || Array.isArray(rawCommand)) {
    throw new EvalManifestError(`${label}: expected an object with a "command" string`);
  }
  if (typeof rawCommand.command !== 'string' || rawCommand.command.trim() === '') {
    throw new EvalManifestError(`${label}: "command" must be a non-empty string`);
  }
  const args = rawCommand.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new EvalManifestError(`${label}: "args" must be an array of strings`);
  }
  const env = rawCommand.env ?? {};
  if (typeof env !== 'object' || Array.isArray(env) || Object.values(env).some((value) => typeof value !== 'string')) {
    throw new EvalManifestError(`${label}: "env" must be an object of string values`);
  }
  return { command: rawCommand.command, args: [...args], env: { ...env } };
}

export function normalizeManifest(raw, source = '<inline>') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EvalManifestError(`${source}: manifest must be a JSON object`);
  }
  if (raw.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new EvalManifestError(`${source}: unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)} (expected ${MANIFEST_SCHEMA_VERSION})`);
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new EvalManifestError(`${source}: manifest must define a non-empty "tasks" array`);
  }
  const defaults = raw.defaults ?? {};
  if (typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new EvalManifestError(`${source}: "defaults" must be an object`);
  }

  const seen = new Set();
  const tasks = raw.tasks.map((rawTask, index) => {
    const label = `${source}: tasks[${index}]`;
    if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
      throw new EvalManifestError(`${label}: each task must be an object`);
    }
    const id = rawTask.id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new EvalManifestError(`${label}: "id" must be a non-empty string`);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
      throw new EvalManifestError(`${label}: "id" must match [a-zA-Z0-9][a-zA-Z0-9._-]*, got "${id}"`);
    }
    if (seen.has(id)) {
      throw new EvalManifestError(`${source}: duplicate task id "${id}"`);
    }
    seen.add(id);

    if (typeof rawTask.prompt !== 'string' || rawTask.prompt.trim() === '') {
      throw new EvalManifestError(`${label} (${id}): "prompt" must be a non-empty string`);
    }

    const model = rawTask.model ?? defaults.model;
    if (typeof model !== 'string' || model.trim() === '') {
      throw new EvalManifestError(`${label} (${id}): "model" must be stated explicitly on the task or in defaults`);
    }

    const budgetUsd = rawTask.budgetUsd ?? defaults.budgetUsd;
    if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new EvalManifestError(`${label} (${id}): "budgetUsd" must be stated explicitly as a positive number`);
    }

    const solverTimeoutMs = requirePositiveInteger(
      rawTask.solverTimeoutMs ?? defaults.solverTimeoutMs,
      `${label} (${id}): "solverTimeoutMs"`,
      DEFAULT_SOLVER_TIMEOUT_MS,
    );
    const verifierTimeoutMs = requirePositiveInteger(
      rawTask.verifierTimeoutMs ?? defaults.verifierTimeoutMs,
      `${label} (${id}): "verifierTimeoutMs"`,
      DEFAULT_VERIFIER_TIMEOUT_MS,
    );

    const fixture = rawTask.fixture ?? {};
    if (typeof fixture !== 'object' || Array.isArray(fixture)) {
      throw new EvalManifestError(`${label} (${id}): "fixture" must be an object`);
    }
    const verifier = rawTask.verifier ?? {};
    if (typeof verifier !== 'object' || Array.isArray(verifier)) {
      throw new EvalManifestError(`${label} (${id}): "verifier" must be an object`);
    }

    return {
      id,
      prompt: rawTask.prompt,
      model,
      budgetUsd,
      modelSource: rawTask.model === undefined ? 'defaults' : 'task',
      budgetSource: rawTask.budgetUsd === undefined ? 'defaults' : 'task',
      solverTimeoutMs,
      verifierTimeoutMs,
      fixtureFiles: normalizeFiles(fixture.files, `${label} (${id}): fixture`),
      solver: normalizeCommand(rawTask.solver, `${label} (${id}): solver`),
      verifier: {
        ...normalizeCommand(verifier, `${label} (${id}): verifier`),
        files: normalizeFiles(verifier.files, `${label} (${id}): verifier`),
      },
    };
  });

  return { schemaVersion: MANIFEST_SCHEMA_VERSION, name: typeof raw.name === 'string' ? raw.name : 'unnamed-eval-manifest', tasks };
}

export function loadManifest(manifestPath) {
  const resolved = path.resolve(manifestPath);
  if (!existsSync(resolved)) {
    throw new EvalManifestError(`manifest not found: ${resolved}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new EvalManifestError(`manifest is not valid JSON (${resolved}): ${error.message}`);
  }
  return normalizeManifest(parsed, resolved);
}

function materializeFiles(rootDir, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
}

function runCommandSync(spec, { cwd, env, timeoutMs }) {
  const startedAt = Date.now();
  const result = spawnSync(spec.command, spec.args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = result.error?.code === 'ETIMEDOUT' || (result.signal === 'SIGKILL' && durationMs >= timeoutMs);
  const spawnFailed = Boolean(result.error) && !timedOut;
  return {
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    timedOut,
    spawnError: spawnFailed ? result.error.message : null,
    durationMs,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
  };
}

export function createRunRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-eval-'));
  return assertOutsideRepoCheckout(root, 'run root');
}

export function runTask(task, options = {}) {
  const runRoot = options.runRoot ?? createRunRoot();
  const runId = options.runId ?? randomUUID();
  const taskRoot = assertOutsideRepoCheckout(path.join(runRoot, task.id), `task root for ${task.id}`);
  const workspaceDir = path.join(taskRoot, 'workspace');
  const verifierDir = path.join(taskRoot, 'verifier');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(verifierDir, { recursive: true });

  materializeFiles(workspaceDir, task.fixtureFiles);
  materializeFiles(verifierDir, task.verifier.files);

  const startedAt = new Date().toISOString();
  const solverEnv = {
    ...process.env,
    ...task.solver.env,
    INVOKER_EVAL_TASK_ID: task.id,
    INVOKER_EVAL_RUN_ID: runId,
    INVOKER_EVAL_PROMPT: task.prompt,
    INVOKER_EVAL_MODEL: task.model,
    INVOKER_EVAL_BUDGET_USD: String(task.budgetUsd),
    INVOKER_EVAL_WORKDIR: workspaceDir,
  };
  delete solverEnv.INVOKER_EVAL_VERIFIER_DIR;
  const solver = runCommandSync(task.solver, {
    cwd: workspaceDir,
    env: solverEnv,
    timeoutMs: task.solverTimeoutMs,
  });

  const verifier = runCommandSync(task.verifier, {
    cwd: verifierDir,
    env: {
      ...process.env,
      ...task.verifier.env,
      INVOKER_EVAL_TASK_ID: task.id,
      INVOKER_EVAL_RUN_ID: runId,
      INVOKER_EVAL_WORKDIR: workspaceDir,
      INVOKER_EVAL_VERIFIER_DIR: verifierDir,
    },
    timeoutMs: task.verifierTimeoutMs,
  });

  let graded = 'fail';
  let gradeReason = `verifier exited ${verifier.exitCode}`;
  if (verifier.timedOut) {
    gradeReason = `verifier timed out after ${task.verifierTimeoutMs}ms`;
  } else if (verifier.spawnError) {
    gradeReason = `verifier failed to start: ${verifier.spawnError}`;
  } else if (verifier.exitCode === 0) {
    graded = 'pass';
    gradeReason = 'verifier exited 0';
  }

  const finishedAt = new Date().toISOString();
  const row = {
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    runId,
    taskId: task.id,
    startedAt,
    finishedAt,
    model: task.model,
    modelSource: task.modelSource,
    budgetUsd: task.budgetUsd,
    budgetSource: task.budgetSource,
    graded,
    gradeSource: GRADE_SOURCE,
    gradeReason,
    gradeIgnoredSolverOutcome: true,
    solver: {
      command: [task.solver.command, ...task.solver.args],
      exitCode: solver.exitCode,
      signal: solver.signal,
      timedOut: solver.timedOut,
      timeoutMs: task.solverTimeoutMs,
      spawnError: solver.spawnError,
      durationMs: solver.durationMs,
      stdout: solver.stdout,
      stderr: solver.stderr,
    },
    verifier: {
      command: [task.verifier.command, ...task.verifier.args],
      exitCode: verifier.exitCode,
      signal: verifier.signal,
      timedOut: verifier.timedOut,
      timeoutMs: task.verifierTimeoutMs,
      spawnError: verifier.spawnError,
      durationMs: verifier.durationMs,
      stdout: verifier.stdout,
      stderr: verifier.stderr,
    },
    workspaceDir,
    verifierDir,
  };

  if (options.keep !== true) {
    rmSync(taskRoot, { recursive: true, force: true });
  }
  return row;
}

export function runManifest(manifest, options = {}) {
  const runId = options.runId ?? randomUUID();
  const runRoot = options.runRoot ?? createRunRoot();
  const outPath = assertOutsideRepoCheckout(options.outPath ?? path.join(runRoot, 'results.jsonl'), 'results path');
  mkdirSync(path.dirname(outPath), { recursive: true });

  const selected = options.taskId
    ? manifest.tasks.filter((task) => task.id === options.taskId)
    : manifest.tasks;
  if (selected.length === 0) {
    throw new EvalManifestError(`no task matches --task ${options.taskId}`);
  }

  const rows = [];
  for (const task of selected) {
    rows.push(runTask(task, { runRoot, runId, keep: options.keep === true }));
  }
  writeFileSync(outPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  return { runId, runRoot, outPath, rows };
}

export function parseArgs(argv) {
  const parsed = { mode: null, manifest: '', taskId: '', outPath: undefined, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--self-test') parsed.mode = 'self-test';
    else if (arg === '--print-schema') parsed.mode = 'print-schema';
    else if (arg === '--manifest') { parsed.mode = 'run'; parsed.manifest = argv[index + 1] ?? ''; index += 1; }
    else if (arg.startsWith('--manifest=')) { parsed.mode = 'run'; parsed.manifest = arg.slice('--manifest='.length); }
    else if (arg === '--task') { parsed.taskId = argv[index + 1] ?? ''; index += 1; }
    else if (arg.startsWith('--task=')) parsed.taskId = arg.slice('--task='.length);
    else if (arg === '--out') { parsed.outPath = argv[index + 1] ?? ''; index += 1; }
    else if (arg.startsWith('--out=')) parsed.outPath = arg.slice('--out='.length);
    else if (arg === '--keep') parsed.keep = true;
    else if (arg === '--help' || arg === '-h') parsed.mode = 'help';
    else throw new EvalManifestError(`unknown argument: ${arg}`);
  }
  if (parsed.mode === 'run' && parsed.manifest.trim() === '') {
    throw new EvalManifestError('--manifest requires a path');
  }
  return parsed;
}

function schemaDescription() {
  return {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    gradeSource: GRADE_SOURCE,
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      name: 'string',
      defaults: { model: 'string', budgetUsd: 'number', solverTimeoutMs: 'integer ms', verifierTimeoutMs: 'integer ms' },
      tasks: [
        {
          id: 'string matching [a-zA-Z0-9][a-zA-Z0-9._-]*',
          prompt: 'string handed to the solver as INVOKER_EVAL_PROMPT',
          model: 'string (required here or in defaults)',
          budgetUsd: 'positive number (required here or in defaults)',
          solverTimeoutMs: 'integer ms',
          verifierTimeoutMs: 'integer ms',
          fixture: { files: { 'relative/path': 'contents seeded into the disposable workspace' } },
          solver: { command: 'string', args: ['string'], env: { KEY: 'value' } },
          verifier: {
            command: 'string',
            args: ['string'],
            env: { KEY: 'value' },
            files: { 'relative/path': 'contents seeded into the verifier directory, never visible to the solver' },
          },
        },
      ],
    },
    resultRow: {
      resultSchemaVersion: 'number',
      runId: 'uuid',
      taskId: 'string',
      startedAt: 'ISO-8601',
      finishedAt: 'ISO-8601',
      model: 'string',
      modelSource: 'task | defaults',
      budgetUsd: 'number',
      budgetSource: 'task | defaults',
      graded: 'pass | fail',
      gradeSource: GRADE_SOURCE,
      gradeReason: 'string',
      gradeIgnoredSolverOutcome: 'always true',
      solver: { command: ['string'], exitCode: 'number | null', signal: 'string | null', timedOut: 'boolean', timeoutMs: 'number', spawnError: 'string | null', durationMs: 'number', stdout: 'string', stderr: 'string' },
      verifier: { command: ['string'], exitCode: 'number | null', signal: 'string | null', timedOut: 'boolean', timeoutMs: 'number', spawnError: 'string | null', durationMs: 'number', stdout: 'string', stderr: 'string' },
      workspaceDir: 'absolute path inside a disposable temp root',
      verifierDir: 'absolute path inside a disposable temp root',
    },
  };
}

function gitSnapshot() {
  const status = spawnSync('git', ['status', '--porcelain=v1'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  return `${head.stdout ?? ''}\n${status.stdout ?? ''}`;
}

function selfTestManifest() {
  return {
    schemaVersion: 1,
    name: 'e2e-eval-runner self-test',
    defaults: { model: 'claude-opus-5', budgetUsd: 0.05, solverTimeoutMs: 60_000, verifierTimeoutMs: 60_000 },
    tasks: [
      {
        id: 'solver-fails-but-final-state-is-correct',
        prompt: 'Write hello into answer.txt.',
        solver: { command: 'bash', args: ['-c', 'printf hello > answer.txt; exit 3'] },
        verifier: {
          command: 'bash',
          args: ['-c', '[ "$(cat "$INVOKER_EVAL_WORKDIR/answer.txt")" = "hello" ] && echo verifier-ok'],
        },
      },
      {
        id: 'solver-succeeds-but-final-state-is-wrong',
        prompt: 'Write hello into answer.txt.',
        solver: { command: 'bash', args: ['-c', 'echo "I have completed the task."; exit 0'] },
        verifier: {
          command: 'bash',
          args: ['-c', '[ -f "$INVOKER_EVAL_WORKDIR/answer.txt" ] || { echo missing-answer >&2; exit 1; }'],
        },
      },
      {
        id: 'solver-times-out-after-correct-write',
        prompt: 'Write hello into answer.txt.',
        solverTimeoutMs: 1_500,
        solver: { command: 'bash', args: ['-c', 'printf hello > answer.txt; sleep 45'] },
        verifier: {
          command: 'bash',
          args: ['-c', '[ "$(cat "$INVOKER_EVAL_WORKDIR/answer.txt")" = "hello" ]'],
        },
      },
      {
        id: 'verifier-assets-are-hidden-from-the-solver',
        prompt: 'Record everything you can read.',
        fixture: { files: { 'notes/seed.txt': 'seed\n' } },
        solver: { command: 'bash', args: ['-c', 'find . -type f | sort > listing.txt'] },
        verifier: {
          command: 'bash',
          args: ['-c', 'grep -q seed.txt "$INVOKER_EVAL_WORKDIR/listing.txt" && ! grep -q reference-solution "$INVOKER_EVAL_WORKDIR/listing.txt" && [ ! -e "$INVOKER_EVAL_WORKDIR/reference-solution.txt" ] && [ -f reference-solution.txt ]'],
          files: { 'reference-solution.txt': 'the answer the solver must never see\n' },
        },
      },
      {
        id: 'verifier-timeout-grades-as-fail',
        prompt: 'Nothing to do.',
        verifierTimeoutMs: 1_200,
        solver: { command: 'bash', args: ['-c', 'true'] },
        verifier: { command: 'bash', args: ['-c', 'sleep 45'] },
      },
    ],
  };
}

function selfTest() {
  const failures = [];
  const checks = [];
  const check = (label, condition) => {
    checks.push(label);
    if (!condition) failures.push(label);
  };
  const expectManifestError = (label, build) => {
    let threw = null;
    try { build(); } catch (error) { threw = error; }
    check(`${label} is rejected by manifest validation`, threw instanceof EvalManifestError);
  };

  const base = selfTestManifest();
  const clone = () => JSON.parse(JSON.stringify(base));

  expectManifestError('a task with no model', () => {
    const raw = clone();
    delete raw.defaults.model;
    normalizeManifest(raw, 'no-model');
  });
  expectManifestError('a task with a zero budget', () => {
    const raw = clone();
    raw.defaults.budgetUsd = 0;
    normalizeManifest(raw, 'zero-budget');
  });
  expectManifestError('a fixture path that escapes the workspace', () => {
    const raw = clone();
    raw.tasks[0].fixture = { files: { '../escape.txt': 'no' } };
    normalizeManifest(raw, 'escaping-fixture');
  });
  expectManifestError('an absolute fixture path', () => {
    const raw = clone();
    raw.tasks[0].fixture = { files: { '/etc/passwd': 'no' } };
    normalizeManifest(raw, 'absolute-fixture');
  });
  expectManifestError('duplicate task ids', () => {
    const raw = clone();
    raw.tasks = [raw.tasks[0], raw.tasks[0]];
    normalizeManifest(raw, 'duplicate-ids');
  });
  expectManifestError('a task with no solver command', () => {
    const raw = clone();
    delete raw.tasks[0].solver;
    normalizeManifest(raw, 'no-solver');
  });
  expectManifestError('an unsupported schemaVersion', () => {
    const raw = clone();
    raw.schemaVersion = 99;
    normalizeManifest(raw, 'bad-version');
  });
  expectManifestError('a results path inside the source checkout', () =>
    assertOutsideRepoCheckout(path.join(REPO_ROOT, 'results.jsonl'), 'results path'));

  const manifest = normalizeManifest(base, 'self-test');
  check('the self-test manifest normalizes', manifest.tasks.length === base.tasks.length);

  const checkoutBefore = gitSnapshot();
  const runRoot = createRunRoot();
  const outPath = path.join(runRoot, 'self-test-results.jsonl');
  const run = runManifest(manifest, { runRoot, outPath });
  const checkoutAfter = gitSnapshot();

  const byId = new Map(run.rows.map((row) => [row.taskId, row]));
  const rowFor = (id) => byId.get(id) ?? {};

  check('every task produced one result row', run.rows.length === manifest.tasks.length);

  const failedSolver = rowFor('solver-fails-but-final-state-is-correct');
  check('a task whose solver exits nonzero still grades pass on correct final state', failedSolver.graded === 'pass');
  check('the nonzero solver exit code is recorded', failedSolver.solver?.exitCode === 3);
  check('grading is attributed to the verifier exit code', failedSolver.gradeSource === GRADE_SOURCE);
  check('independent verifier stdout is captured', (failedSolver.verifier?.stdout ?? '').includes('verifier-ok'));

  const lyingSolver = rowFor('solver-succeeds-but-final-state-is-wrong');
  check('a task whose solver exits zero still grades fail on wrong final state', lyingSolver.graded === 'fail');
  check('the zero solver exit code is recorded alongside the fail grade', lyingSolver.solver?.exitCode === 0);
  check('verifier stderr is captured on failure', (lyingSolver.verifier?.stderr ?? '').includes('missing-answer'));

  const timedOut = rowFor('solver-times-out-after-correct-write');
  check('a solver that overruns its timeout is killed', timedOut.solver?.timedOut === true);
  check('the verifier still grades final state after a solver timeout', timedOut.graded === 'pass');

  const hidden = rowFor('verifier-assets-are-hidden-from-the-solver');
  check('verifier assets are never materialized in the solver workspace', hidden.graded === 'pass');

  const verifierTimeout = rowFor('verifier-timeout-grades-as-fail');
  check('a verifier that overruns its timeout grades fail', verifierTimeout.graded === 'fail' && verifierTimeout.verifier?.timedOut === true);

  check('the source checkout is unchanged by a run', checkoutBefore === checkoutAfter);
  check('workspaces live outside the source checkout', run.rows.every((row) => path.relative(REPO_ROOT, row.workspaceDir).startsWith('..')));
  check('disposable task directories are removed after grading', run.rows.every((row) => !existsSync(row.workspaceDir)));

  const written = readFileSync(outPath, 'utf8').trim().split('\n');
  check('results are written as one JSON object per line', written.length === run.rows.length);
  let parsedRows = [];
  try { parsedRows = written.map((line) => JSON.parse(line)); } catch { parsedRows = []; }
  check('every result line parses as JSON', parsedRows.length === run.rows.length);
  check('every row carries the result schema version', parsedRows.every((row) => row.resultSchemaVersion === RESULT_SCHEMA_VERSION));
  check('every row states its model and budget explicitly', parsedRows.every((row) => typeof row.model === 'string' && row.model.length > 0 && typeof row.budgetUsd === 'number' && row.budgetUsd > 0));
  check('every row shares one run id', new Set(parsedRows.map((row) => row.runId)).size === 1);
  check('every row records that the solver outcome was ignored', parsedRows.every((row) => row.gradeIgnoredSolverOutcome === true));

  const manifestPath = path.join(runRoot, 'self-test-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(base));
  const selfPath = fileURLToPath(import.meta.url);
  const failingRun = spawnSync(process.execPath, [selfPath, '--manifest', manifestPath, '--out', path.join(runRoot, 'cli-all.jsonl')], {
    encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
  });
  check(`a manifest containing a failing task exits 1 (got ${failingRun.status})`, failingRun.status === 1);
  const passingRun = spawnSync(process.execPath, [selfPath, '--manifest', manifestPath, '--task', 'solver-fails-but-final-state-is-correct', '--out', path.join(runRoot, 'cli-one.jsonl')], {
    encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
  });
  check(`a manifest whose selected task passes exits 0 (got ${passingRun.status})`, passingRun.status === 0);
  check('--task selects a single task', readFileSync(path.join(runRoot, 'cli-one.jsonl'), 'utf8').trim().split('\n').length === 1);

  const badArgs = spawnSync(process.execPath, [selfPath, '--manifest', path.join(runRoot, 'missing.json')], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  check(`a missing manifest exits 2 (got ${badArgs.status})`, badArgs.status === 2);

  rmSync(runRoot, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`FAIL e2e-eval-runner self-test: ${failures.length}/${checks.length} checks failed`);
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log(`PASS e2e-eval-runner self-test: ${checks.length} checks, 0 failures`);
  return 0;
}

function runCli(parsed) {
  const manifest = loadManifest(parsed.manifest);
  const result = runManifest(manifest, {
    taskId: parsed.taskId || undefined,
    outPath: parsed.outPath,
    keep: parsed.keep,
  });
  for (const row of result.rows) {
    console.log(`[eval] ${row.graded.toUpperCase()} ${row.taskId} model=${row.model} budgetUsd=${row.budgetUsd} (${row.gradeReason})`);
  }
  const failed = result.rows.filter((row) => row.graded !== 'pass');
  console.log(`[eval] results: ${result.outPath}`);
  console.log(`[eval] ${result.rows.length - failed.length}/${result.rows.length} tasks passed independent verification`);
  return failed.length === 0 ? 0 : 1;
}

const selfPath = fileURLToPath(import.meta.url);
const isMain = process.argv[1] ? path.resolve(process.argv[1]) === selfPath : false;

if (isMain) {
  let exitCode = 0;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.mode === 'self-test') exitCode = selfTest();
    else if (parsed.mode === 'print-schema') console.log(JSON.stringify(schemaDescription(), null, 2));
    else if (parsed.mode === 'run') exitCode = runCli(parsed);
    else if (parsed.mode === 'help') console.log(USAGE);
    else { console.error(USAGE); exitCode = 2; }
  } catch (error) {
    console.error(`e2e-eval-runner: ${error.message}`);
    exitCode = 2;
  }
  process.exitCode = exitCode;
}
