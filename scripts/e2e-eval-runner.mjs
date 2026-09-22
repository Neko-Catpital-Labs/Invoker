#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const MANIFEST_VERSION = 1;
export const RESULT_SCHEMA_VERSION = 1;
export const DEFAULT_SOLVE_TIMEOUT_MS = 600_000;
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
export const MAX_CAPTURED_OUTPUT_CHARS = 8_000;
export const MAX_PROCESS_BUFFER_BYTES = 16 * 1024 * 1024;
export const TEMP_DIR_PREFIX = 'invoker-e2e-eval-';
export const SOLVER_DENIED_ENV_PREFIXES = ['EVAL_VERIFIER_', 'EVAL_SOLUTION_', 'EVAL_REFERENCE_'];

export const VERDICT_PASS = 'pass';
export const VERDICT_FAIL = 'fail';
export const VERDICT_ERROR = 'error';

const USAGE = [
  'usage: e2e-eval-runner.mjs --manifest <path> [--task <id>]... [--results <path>]',
  '                          [--model <id>] [--budget-usd <n>] [--no-gate] [--keep]',
  '       e2e-eval-runner.mjs --self-test',
  '',
  'Runs each manifest task in a disposable temporary workspace, then grades the',
  'final state of that workspace with an independent verifier process. A task',
  'verdict is derived only from the verifier exit code: the solver exit code is',
  'recorded but never consulted, so a solver that reports success without doing',
  'the work is still graded fail.',
  '',
  'Manifest shape (JSON):',
  '  {',
  '    "version": 1,',
  '    "defaults": { "model": "...", "budgetUsd": 0.25, "timeoutMs": 600000 },',
  '    "tasks": [{',
  '      "id": "kebab-id",',
  '      "prompt": "what the agent under test is asked to do",',
  '      "model": "claude-opus-5",',
  '      "budgetUsd": 0.25,',
  '      "fixture": { "files": { "src/sum.js": "..." } },',
  '      "solve":  { "run": ["bash", "-lc", "..."], "timeoutMs": 600000 },',
  '      "verify": { "run": ["bash", "-lc", "..."], "timeoutMs": 120000,',
  '                  "files": { "check.sh": "..." } },',
  '      "solution": { "files": { "src/sum.js": "..." } }',
  '    }]',
  '  }',
  '',
  '"model" and "budgetUsd" are required on every task (directly or via defaults)',
  'and are exported to the solver as EVAL_MODEL and EVAL_BUDGET_USD. This runner',
  'records them; enforcing a spend ceiling is the agent adapter\'s job.',
  '',
  'Every "run" is argv, executed without a shell: EVAL_* variables are not',
  'expanded unless the task invokes a shell itself ("bash", "-c", "...").',
  '',
  '"verify.files" are written outside the workspace and "solution" is never',
  'written to disk at all, so the solver cannot read the grader or the answer.',
  '',
  'Results are appended to a JSONL file, one row per task.',
  'Exits non-zero when any task is not "pass" unless --no-gate is passed.',
].join('\n');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function truncateOutput(value) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= MAX_CAPTURED_OUTPUT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_CAPTURED_OUTPUT_CHARS), truncated: true };
}

export function assertSafeRelativePath(relPath, label = 'fixture path') {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (isAbsolute(relPath)) {
    throw new Error(`${label} must be relative, got "${relPath}"`);
  }
  const segments = relPath.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`${label} must not escape its directory, got "${relPath}"`);
  }
  return relPath;
}

export function resolveContainedPath(baseDir, relPath, label = 'fixture path') {
  assertSafeRelativePath(relPath, label);
  const base = resolve(baseDir);
  const resolved = resolve(base, relPath);
  if (resolved === base || !resolved.startsWith(base + sep)) {
    throw new Error(`${label} resolved outside its directory: "${relPath}"`);
  }
  return resolved;
}

export function assertDisposableRoot(dir, sourceCheckoutRoot = REPO_ROOT) {
  const resolved = realpathSync(dir);
  const tempRoot = realpathSync(tmpdir());
  const repoRoot = realpathSync(sourceCheckoutRoot);
  if (!resolved.startsWith(tempRoot + sep)) {
    throw new Error(`refusing to run an eval outside the temporary directory: ${resolved}`);
  }
  if (resolved === repoRoot || resolved.startsWith(repoRoot + sep)) {
    throw new Error(`refusing to run an eval inside the source checkout: ${resolved}`);
  }
  return resolved;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireArgv(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array of command arguments`);
  }
  value.forEach((entry, index) => requireString(entry, `${label}[${index}]`));
  return [...value];
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer number of milliseconds`);
  }
  return value;
}

function requireFileMap(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object mapping relative paths to file contents`);
  }
  const files = {};
  for (const [relPath, contents] of Object.entries(value)) {
    assertSafeRelativePath(relPath, `${label} key`);
    if (typeof contents !== 'string') {
      throw new Error(`${label}["${relPath}"] must be a string`);
    }
    files[relPath] = contents;
  }
  return files;
}

function resolveInherited(task, defaults, key, label) {
  if (task[key] !== undefined) return { value: task[key], source: 'task' };
  if (defaults[key] !== undefined) return { value: defaults[key], source: 'defaults' };
  throw new Error(`${label} is required (set it on the task or in manifest defaults)`);
}

export function parseManifest(input, source = '<inline>') {
  let manifest;
  if (typeof input === 'string') {
    try {
      manifest = JSON.parse(input);
    } catch (error) {
      throw new Error(`${source}: manifest is not valid JSON (${error.message})`);
    }
  } else {
    manifest = input;
  }

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${source}: manifest must be a JSON object`);
  }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(`${source}: unsupported manifest version ${JSON.stringify(manifest.version)} (expected ${MANIFEST_VERSION})`);
  }
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
    throw new Error(`${source}: manifest must declare a non-empty "tasks" array`);
  }

  const defaults = manifest.defaults ?? {};
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error(`${source}: manifest "defaults" must be an object`);
  }

  const seen = new Set();
  const tasks = manifest.tasks.map((rawTask, index) => {
    if (rawTask === null || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
      throw new Error(`${source}: tasks[${index}] must be an object`);
    }
    const id = requireString(rawTask.id, `${source}: tasks[${index}].id`);
    if (seen.has(id)) {
      throw new Error(`${source}: duplicate task id "${id}"`);
    }
    seen.add(id);

    const label = `${source}: task "${id}"`;
    const model = resolveInherited(rawTask, defaults, 'model', `${label} "model"`);
    requireString(model.value, `${label} "model"`);
    const budget = resolveInherited(rawTask, defaults, 'budgetUsd', `${label} "budgetUsd"`);
    if (typeof budget.value !== 'number' || !Number.isFinite(budget.value) || budget.value < 0) {
      throw new Error(`${label} "budgetUsd" must be a finite number of dollars >= 0`);
    }

    const solve = rawTask.solve;
    if (solve === null || typeof solve !== 'object' || Array.isArray(solve)) {
      throw new Error(`${label} must declare a "solve" object`);
    }
    const verify = rawTask.verify;
    if (verify === null || typeof verify !== 'object' || Array.isArray(verify)) {
      throw new Error(`${label} must declare a "verify" object`);
    }

    const inheritedTimeout = defaults.timeoutMs === undefined ? undefined : requirePositiveInteger(defaults.timeoutMs, `${source}: defaults.timeoutMs`);
    const solveTimeoutMs = solve.timeoutMs === undefined
      ? (rawTask.timeoutMs ?? inheritedTimeout ?? DEFAULT_SOLVE_TIMEOUT_MS)
      : solve.timeoutMs;
    const verifyTimeoutMs = verify.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;

    return {
      id,
      prompt: rawTask.prompt === undefined ? '' : requireString(rawTask.prompt, `${label} "prompt"`),
      model: model.value,
      modelSource: model.source,
      budgetUsd: budget.value,
      budgetSource: budget.source,
      fixture: { files: requireFileMap(rawTask.fixture?.files, `${label} fixture.files`) },
      solve: {
        run: requireArgv(solve.run, `${label} solve.run`),
        timeoutMs: requirePositiveInteger(solveTimeoutMs, `${label} solve.timeoutMs`),
        env: requireEnvMap(solve.env, `${label} solve.env`),
      },
      verify: {
        run: requireArgv(verify.run, `${label} verify.run`),
        timeoutMs: requirePositiveInteger(verifyTimeoutMs, `${label} verify.timeoutMs`),
        files: requireFileMap(verify.files, `${label} verify.files`),
      },
      solution: rawTask.solution ?? null,
    };
  });

  return { version: MANIFEST_VERSION, source, defaults, tasks };
}

function requireEnvMap(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object of environment variables`);
  }
  const env = {};
  for (const [key, entry] of Object.entries(value)) {
    requireString(key, `${label} key`);
    if (typeof entry !== 'string') {
      throw new Error(`${label}["${key}"] must be a string`);
    }
    env[key] = entry;
  }
  return env;
}

export function referenceSolutionDigest(task) {
  if (task.solution === null || task.solution === undefined) return null;
  return sha256(JSON.stringify(task.solution));
}

export function createTaskRoot(taskId) {
  const safeId = String(taskId).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
  const root = assertDisposableRoot(mkdtempSync(join(tmpdir(), `${TEMP_DIR_PREFIX}${safeId}-`)));
  const workspace = join(root, 'workspace');
  const verifierDir = join(root, 'verifier');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(verifierDir, { recursive: true });
  return { root, workspace, verifierDir };
}

export function materializeFiles(baseDir, files, label) {
  const written = [];
  for (const [relPath, contents] of Object.entries(files)) {
    const target = resolveContainedPath(baseDir, relPath, label);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    written.push(relPath);
  }
  return written.sort();
}

export function buildSolverEnv(task, workspace) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SOLVER_DENIED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  Object.assign(env, task.solve.env, {
    EVAL_TASK_ID: task.id,
    EVAL_PROMPT: task.prompt,
    EVAL_MODEL: task.model,
    EVAL_BUDGET_USD: String(task.budgetUsd),
    EVAL_WORKSPACE: workspace,
  });
  for (const key of Object.keys(env)) {
    if (SOLVER_DENIED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      throw new Error(`solver environment must not carry "${key}"`);
    }
  }
  return env;
}

export function buildVerifierEnv(task, workspace, verifierDir) {
  return {
    ...process.env,
    EVAL_TASK_ID: task.id,
    EVAL_WORKSPACE: workspace,
    EVAL_VERIFIER_DIR: verifierDir,
  };
}

export function runProcess(argv, { cwd, env, timeoutMs }) {
  const startedAt = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    maxBuffer: MAX_PROCESS_BUFFER_BYTES,
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = result.error?.code === 'ETIMEDOUT'
    || (result.signal === 'SIGKILL' && durationMs + 1 >= timeoutMs);
  const spawnError = result.error && !timedOut ? `${result.error.code ?? 'ERROR'}: ${result.error.message}` : null;
  const stdout = truncateOutput(result.stdout);
  const stderr = truncateOutput(result.stderr);
  return {
    command: argv,
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    timedOut,
    timeoutMs,
    spawnError,
    durationMs,
    stdout: stdout.text,
    stderr: stderr.text,
    outputTruncated: stdout.truncated || stderr.truncated,
  };
}

function walkFiles(dir, base, out) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(base, abs).split(sep).join('/');
    if (entry.isSymbolicLink()) out.push(`symlink ${rel} ${sha256(readlinkSync(abs))}`);
    else if (entry.isDirectory()) walkFiles(abs, base, out);
    else if (entry.isFile()) out.push(`file ${rel} ${sha256(readFileSync(abs))}`);
    else out.push(`other ${rel}`);
  }
  return out;
}

export function digestDirectory(dir) {
  const lines = walkFiles(dir, dir, []);
  return { digest: sha256(lines.join('\n')), entryCount: lines.length };
}

export function gradeVerifier(verifier) {
  if (verifier.spawnError) return VERDICT_ERROR;
  if (verifier.timedOut) return VERDICT_FAIL;
  return verifier.exitCode === 0 ? VERDICT_PASS : VERDICT_FAIL;
}

export function runTask(task, options = {}) {
  const runId = options.runId ?? 'local';
  const { root, workspace, verifierDir } = createTaskRoot(task.id);
  const startedAt = new Date();
  try {
    const fixtureFiles = materializeFiles(workspace, task.fixture.files, `task "${task.id}" fixture path`);
    const verifierFiles = materializeFiles(verifierDir, task.verify.files, `task "${task.id}" verifier path`);
    const fixtureDigest = digestDirectory(workspace);

    const solver = runProcess(task.solve.run, {
      cwd: workspace,
      env: buildSolverEnv(task, workspace),
      timeoutMs: task.solve.timeoutMs,
    });

    const verifier = runProcess(task.verify.run, {
      cwd: workspace,
      env: buildVerifierEnv(task, workspace, verifierDir),
      timeoutMs: task.verify.timeoutMs,
    });

    const finalDigest = digestDirectory(workspace);
    const verdict = gradeVerifier(verifier);
    const solverReportedSuccess = solver.exitCode === 0 && !solver.timedOut && !solver.spawnError;
    const finishedAt = new Date();

    return {
      schemaVersion: RESULT_SCHEMA_VERSION,
      runId,
      taskId: task.id,
      prompt: task.prompt,
      model: task.model,
      modelSource: task.modelSource,
      budgetUsd: task.budgetUsd,
      budgetSource: task.budgetSource,
      verdict,
      gradedBy: 'independent-verifier-exit-code',
      solverReportedSuccess,
      independenceDivergence: solverReportedSuccess !== (verdict === VERDICT_PASS),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      solver,
      verifier,
      fixture: {
        files: fixtureFiles,
        digest: fixtureDigest.digest,
        entryCount: fixtureDigest.entryCount,
      },
      finalState: {
        digest: finalDigest.digest,
        entryCount: finalDigest.entryCount,
        mutated: finalDigest.digest !== fixtureDigest.digest,
      },
      referenceSolution: {
        present: task.solution !== null && task.solution !== undefined,
        digest: referenceSolutionDigest(task),
        writtenToWorkspace: false,
      },
      verifierFiles,
      paths: { root, workspace, verifierDir },
    };
  } finally {
    if (!options.keep) rmSync(root, { recursive: true, force: true });
  }
}

export function runManifest(manifest, options = {}) {
  const runId = options.runId ?? `${Date.now()}-${process.pid}`;
  const selected = options.taskIds && options.taskIds.length > 0
    ? manifest.tasks.filter((task) => options.taskIds.includes(task.id))
    : manifest.tasks;

  if (selected.length === 0) {
    throw new Error(`no manifest task matched ${JSON.stringify(options.taskIds)}`);
  }

  const resultsPath = options.resultsPath
    ?? join(tmpdir(), `${TEMP_DIR_PREFIX}results-${runId}.jsonl`);
  mkdirSync(dirname(resolve(resultsPath)), { recursive: true });
  writeFileSync(resultsPath, '');

  const rows = [];
  for (const task of selected) {
    const overridden = {
      ...task,
      model: options.model ?? task.model,
      modelSource: options.model ? 'cli' : task.modelSource,
      budgetUsd: options.budgetUsd ?? task.budgetUsd,
      budgetSource: options.budgetUsd === undefined ? task.budgetSource : 'cli',
    };
    const row = runTask(overridden, { runId, keep: options.keep });
    appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
    rows.push(row);
    if (!options.quiet) {
      const verifierLine = (row.verifier.stdout || row.verifier.stderr || '').split('\n').find((line) => line.trim() !== '') ?? '';
      console.log(
        `[${row.verdict}] ${row.taskId} model=${row.model} budgetUsd=${row.budgetUsd} `
        + `solverExit=${row.solver.timedOut ? 'timeout' : row.solver.exitCode} `
        + `verifierExit=${row.verifier.timedOut ? 'timeout' : row.verifier.exitCode} `
        + `verifier="${verifierLine.trim()}"`,
      );
    }
  }

  const passed = rows.filter((row) => row.verdict === VERDICT_PASS).length;
  return {
    runId,
    resultsPath,
    rows,
    total: rows.length,
    passed,
    failed: rows.length - passed,
    divergences: rows.filter((row) => row.independenceDivergence).length,
  };
}

function nodeRun(source) {
  return [process.execPath, '-e', source];
}

const SELF_TEST_SECRET = 'REFERENCE-SOLUTION-MUST-NOT-LEAK-42';

export function selfTestManifest() {
  const writeAnswer = "require('node:fs').writeFileSync('answer.txt', '42\\n');";
  const verifyAnswer = [
    "const value = require('node:fs').readFileSync('answer.txt', 'utf8').trim();",
    "if (value !== '42') { console.error('verifier: expected 42, found ' + JSON.stringify(value)); process.exit(1); }",
    "console.log('verifier: answer.txt === 42');",
  ].join('\n');
  const sleepForever = 'setTimeout(() => {}, 60000);';

  return {
    version: MANIFEST_VERSION,
    defaults: { model: 'claude-opus-5', budgetUsd: 0.25, timeoutMs: 30000 },
    tasks: [
      {
        id: 'honest-solver',
        prompt: 'Write 42 into answer.txt',
        fixture: { files: { 'answer.txt': 'todo\n' } },
        solve: { run: nodeRun(writeAnswer) },
        verify: { run: nodeRun(verifyAnswer), timeoutMs: 30000 },
      },
      {
        id: 'lying-solver',
        prompt: 'Write 42 into answer.txt',
        fixture: { files: { 'answer.txt': 'todo\n' } },
        solve: { run: nodeRun('process.exit(0);') },
        verify: { run: nodeRun(verifyAnswer), timeoutMs: 30000 },
      },
      {
        id: 'grumpy-solver',
        prompt: 'Write 42 into answer.txt',
        fixture: { files: { 'answer.txt': 'todo\n' } },
        solve: { run: nodeRun(`${writeAnswer} process.exit(3);`) },
        verify: { run: nodeRun(verifyAnswer), timeoutMs: 30000 },
      },
      {
        id: 'solver-timeout',
        prompt: 'Write 42 into answer.txt',
        fixture: { files: { 'answer.txt': 'todo\n' } },
        solve: { run: nodeRun(sleepForever), timeoutMs: 700 },
        verify: { run: nodeRun(verifyAnswer), timeoutMs: 30000 },
      },
      {
        id: 'verifier-timeout',
        prompt: 'Write 42 into answer.txt',
        fixture: { files: { 'answer.txt': 'todo\n' } },
        solve: { run: nodeRun(writeAnswer) },
        verify: { run: nodeRun(sleepForever), timeoutMs: 700 },
      },
      {
        id: 'missing-solver-binary',
        prompt: 'Write 42 into answer.txt',
        fixture: { files: { 'answer.txt': 'todo\n' } },
        solve: { run: ['invoker-e2e-eval-no-such-binary'], timeoutMs: 30000 },
        verify: { run: nodeRun(verifyAnswer), timeoutMs: 30000 },
      },
      {
        id: 'reference-solution-hidden',
        prompt: 'Record everything visible from the workspace',
        fixture: { files: { 'answer.txt': 'todo\n' } },
        solve: {
          run: nodeRun([
            "const fs = require('node:fs');",
            "fs.writeFileSync('probe.json', JSON.stringify({ entries: fs.readdirSync('.'), parent: fs.readdirSync('..'), env: process.env }));",
          ].join('\n')),
        },
        verify: {
          run: nodeRun([
            "const fs = require('node:fs');",
            "const verifierMarker = fs.readFileSync(require('node:path').join(process.env.EVAL_VERIFIER_DIR, 'marker.txt'), 'utf8').trim();",
            "if (verifierMarker !== 'grader-private') { console.error('verifier: private marker missing'); process.exit(1); }",
            "if (!fs.existsSync('probe.json')) { console.error('verifier: probe.json missing'); process.exit(1); }",
            "console.log('verifier: probe captured, grader stayed private');",
          ].join('\n')),
          timeoutMs: 30000,
          files: { 'marker.txt': 'grader-private\n' },
        },
        solution: { files: { 'answer.txt': `${SELF_TEST_SECRET}\n` } },
      },
    ],
  };
}

const EXPECTED_SELF_TEST = {
  'honest-solver': { verdict: VERDICT_PASS, divergence: false },
  'lying-solver': { verdict: VERDICT_FAIL, divergence: true },
  'grumpy-solver': { verdict: VERDICT_PASS, divergence: true },
  'solver-timeout': { verdict: VERDICT_FAIL, divergence: false },
  'verifier-timeout': { verdict: VERDICT_FAIL, divergence: true },
  'missing-solver-binary': { verdict: VERDICT_FAIL, divergence: false },
  'reference-solution-hidden': { verdict: VERDICT_PASS, divergence: false },
};

function createChecker() {
  const state = { total: 0, failures: [] };
  return {
    state,
    check(label, condition, detail) {
      state.total += 1;
      if (!condition) state.failures.push(detail ? `${label} (${detail})` : label);
    },
    throws(label, fn, expectedFragment) {
      state.total += 1;
      try {
        fn();
        state.failures.push(`${label} (expected a thrown error, none was thrown)`);
      } catch (error) {
        if (expectedFragment && !String(error.message).includes(expectedFragment)) {
          state.failures.push(`${label} (expected message containing "${expectedFragment}", got "${error.message}")`);
        }
      }
    },
  };
}

function gitSnapshot() {
  const result = spawnSync('git', ['status', '--porcelain=v1'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: MAX_PROCESS_BUFFER_BYTES,
  });
  if (result.status !== 0) return null;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return `${head.stdout ?? ''}\n${result.stdout}`;
}

export function selfTest() {
  const checker = createChecker();
  const { check, throws } = checker;
  const checkoutBefore = gitSnapshot();

  const manifest = parseManifest(selfTestManifest(), 'self-test');
  check('self-test manifest parses every task', manifest.tasks.length === Object.keys(EXPECTED_SELF_TEST).length);
  check('manifest defaults supply the model', manifest.tasks[0].modelSource === 'defaults');
  check('manifest defaults supply the budget', manifest.tasks[0].budgetSource === 'defaults');
  check('budget stays explicit on every task', manifest.tasks.every((task) => Number.isFinite(task.budgetUsd)));
  check('model stays explicit on every task', manifest.tasks.every((task) => task.model === 'claude-opus-5'));

  throws('rejects an unsupported manifest version', () => parseManifest({ version: 2, tasks: [] }), 'unsupported manifest version');
  throws('rejects a manifest with no tasks', () => parseManifest({ version: 1, tasks: [] }), 'non-empty "tasks"');
  throws(
    'rejects a task with no model',
    () => parseManifest({ version: 1, tasks: [{ id: 'a', budgetUsd: 1, solve: { run: ['true'] }, verify: { run: ['true'] } }] }),
    '"model" is required',
  );
  throws(
    'rejects a task with no budget',
    () => parseManifest({ version: 1, tasks: [{ id: 'a', model: 'm', solve: { run: ['true'] }, verify: { run: ['true'] } }] }),
    '"budgetUsd" is required',
  );
  throws(
    'rejects duplicate task ids',
    () => parseManifest({
      version: 1,
      defaults: { model: 'm', budgetUsd: 1 },
      tasks: [
        { id: 'a', solve: { run: ['true'] }, verify: { run: ['true'] } },
        { id: 'a', solve: { run: ['true'] }, verify: { run: ['true'] } },
      ],
    }),
    'duplicate task id',
  );
  throws(
    'rejects a task with no verifier',
    () => parseManifest({ version: 1, defaults: { model: 'm', budgetUsd: 1 }, tasks: [{ id: 'a', solve: { run: ['true'] } }] }),
    'must declare a "verify" object',
  );
  throws(
    'rejects a fixture path that escapes the workspace',
    () => parseManifest({
      version: 1,
      defaults: { model: 'm', budgetUsd: 1 },
      tasks: [{ id: 'a', fixture: { files: { '../escape.txt': 'x' } }, solve: { run: ['true'] }, verify: { run: ['true'] } }],
    }),
    'must not escape',
  );
  throws(
    'rejects an absolute fixture path',
    () => parseManifest({
      version: 1,
      defaults: { model: 'm', budgetUsd: 1 },
      tasks: [{ id: 'a', fixture: { files: { '/etc/passwd': 'x' } }, solve: { run: ['true'] }, verify: { run: ['true'] } }],
    }),
    'must be relative',
  );
  throws('rejects a root outside the temporary directory', () => assertDisposableRoot(REPO_ROOT), 'outside the temporary directory');
  const nestedCheckout = mkdtempSync(join(tmpdir(), `${TEMP_DIR_PREFIX}checkout-`));
  const nestedRoot = mkdtempSync(join(nestedCheckout, 'nested-'));
  throws(
    'rejects a root inside the source checkout',
    () => assertDisposableRoot(nestedRoot, nestedCheckout),
    'inside the source checkout',
  );
  check('accepts a disposable root outside the source checkout', assertDisposableRoot(nestedRoot, REPO_ROOT).length > 0);
  rmSync(nestedCheckout, { recursive: true, force: true });
  throws('rejects a verifier path that escapes its directory', () => resolveContainedPath('/tmp/x', '../y'), 'must not escape');

  const resultsPath = join(mkdtempSync(join(tmpdir(), `${TEMP_DIR_PREFIX}selftest-`)), 'results.jsonl');
  const summary = runManifest(manifest, { runId: 'self-test', resultsPath, quiet: true, keep: true });

  check('every task produced a result row', summary.total === manifest.tasks.length, `${summary.total}`);

  for (const row of summary.rows) {
    const expected = EXPECTED_SELF_TEST[row.taskId];
    check(`${row.taskId} has an expectation`, Boolean(expected));
    if (!expected) continue;
    check(`${row.taskId} verdict is ${expected.verdict}`, row.verdict === expected.verdict, `got ${row.verdict}`);
    check(
      `${row.taskId} divergence is ${expected.divergence}`,
      row.independenceDivergence === expected.divergence,
      `got ${row.independenceDivergence}`,
    );
    check(`${row.taskId} is graded by the verifier exit code`, row.gradedBy === 'independent-verifier-exit-code');
    check(`${row.taskId} ran its verifier`, row.verifier.command.length > 0);
    check(`${row.taskId} records the model`, row.model === 'claude-opus-5');
    check(`${row.taskId} records the budget`, row.budgetUsd === 0.25);
    check(
      `${row.taskId} keeps the verifier directory outside the workspace`,
      relative(row.paths.workspace, row.paths.verifierDir).startsWith('..'),
    );
    check(`${row.taskId} used a disposable root`, row.paths.root.includes(TEMP_DIR_PREFIX));
    check(`${row.taskId} never wrote a reference solution`, row.referenceSolution.writtenToWorkspace === false);
  }

  const byId = new Map(summary.rows.map((row) => [row.taskId, row]));

  const lying = byId.get('lying-solver');
  check('lying solver exited 0', lying.solver.exitCode === 0, `got ${lying.solver.exitCode}`);
  check('lying solver is still graded fail', lying.verdict === VERDICT_FAIL);
  check('lying solver left the fixture unmutated', lying.finalState.mutated === false);

  const grumpy = byId.get('grumpy-solver');
  check('grumpy solver exited non-zero', grumpy.solver.exitCode === 3, `got ${grumpy.solver.exitCode}`);
  check('grumpy solver is still graded pass', grumpy.verdict === VERDICT_PASS);

  const solverTimeout = byId.get('solver-timeout');
  check('solver timeout is recorded', solverTimeout.solver.timedOut === true);
  check('solver timeout still ran the verifier', solverTimeout.verifier.exitCode === 1, `got ${solverTimeout.verifier.exitCode}`);
  check('solver timeout is bounded by its budget', solverTimeout.solver.durationMs < 10_000, `${solverTimeout.solver.durationMs}ms`);

  const verifierTimeout = byId.get('verifier-timeout');
  check('verifier timeout is recorded', verifierTimeout.verifier.timedOut === true);
  check('verifier timeout grades fail', verifierTimeout.verdict === VERDICT_FAIL);

  const missingBinary = byId.get('missing-solver-binary');
  check('missing solver binary is recorded', Boolean(missingBinary.solver.spawnError), `${missingBinary.solver.spawnError}`);
  check('missing solver binary does not abort the run', missingBinary.verdict === VERDICT_FAIL);

  const hidden = byId.get('reference-solution-hidden');
  check('reference solution digest is recorded', typeof hidden.referenceSolution.digest === 'string');
  check('reference solution is flagged present', hidden.referenceSolution.present === true);
  const probePath = join(hidden.paths.workspace, 'probe.json');
  const probe = JSON.parse(readFileSync(probePath, 'utf8'));
  check('solver could not see the reference solution', !JSON.stringify(probe).includes(SELF_TEST_SECRET));
  check('solver could not see the verifier directory contents', !probe.entries.includes('marker.txt'));
  check(
    'solver environment carries no grader variables',
    !Object.keys(probe.env).some((key) => SOLVER_DENIED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))),
  );
  check('solver environment carries the model', probe.env.EVAL_MODEL === 'claude-opus-5');
  check('solver environment carries the budget', probe.env.EVAL_BUDGET_USD === '0.25');
  check('honest solver mutated its own workspace', byId.get('honest-solver').finalState.mutated === true);

  const lines = readFileSync(resultsPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
  check('results file has one row per task', lines.length === summary.total, `${lines.length}`);
  const parsedRows = lines.map((line) => JSON.parse(line));
  check('every row declares the schema version', parsedRows.every((row) => row.schemaVersion === RESULT_SCHEMA_VERSION));
  check('every row carries independent verifier output', parsedRows.every((row) => typeof row.verifier.stdout === 'string' && typeof row.verifier.exitCode !== 'undefined'));
  check('every row carries an explicit model and budget', parsedRows.every((row) => typeof row.model === 'string' && typeof row.budgetUsd === 'number'));
  check('every row carries a final-state digest', parsedRows.every((row) => typeof row.finalState.digest === 'string' && row.finalState.digest.length === 64));

  for (const row of summary.rows) rmSync(row.paths.root, { recursive: true, force: true });
  rmSync(dirname(resultsPath), { recursive: true, force: true });

  const cleaned = runManifest(parseManifest(selfTestManifest(), 'self-test-cleanup'), {
    runId: 'self-test-cleanup',
    resultsPath: join(mkdtempSync(join(tmpdir(), `${TEMP_DIR_PREFIX}cleanup-`)), 'results.jsonl'),
    quiet: true,
    taskIds: ['honest-solver'],
  });
  check('disposable roots are removed by default', !existsSyncSafe(cleaned.rows[0].paths.root));
  rmSync(dirname(cleaned.resultsPath), { recursive: true, force: true });

  const checkoutAfter = gitSnapshot();
  check('the source checkout is unchanged', checkoutBefore === checkoutAfter);

  if (checker.state.failures.length > 0) {
    console.error('FAIL e2e-eval-runner self-test');
    for (const failure of checker.state.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return false;
  }

  console.log(
    `PASS e2e-eval-runner self-test: ${checker.state.total} checks over `
    + `${manifest.tasks.length} disposable tasks (verdicts graded by verifier exit code only)`,
  );
  return true;
}

function existsSyncSafe(path) {
  try {
    realpathSync(path);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const parsed = { taskIds: [], gate: true, keep: false, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--self-test') parsed.selfTest = true;
    else if (arg === '--manifest') parsed.manifestPath = next();
    else if (arg === '--task') parsed.taskIds.push(next());
    else if (arg === '--results') parsed.resultsPath = next();
    else if (arg === '--model') parsed.model = next();
    else if (arg === '--budget-usd') {
      const value = Number(next());
      if (!Number.isFinite(value) || value < 0) throw new Error('--budget-usd must be a finite number >= 0');
      parsed.budgetUsd = value;
    } else if (arg === '--no-gate') parsed.gate = false;
    else if (arg === '--keep') parsed.keep = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  return parsed;
}

function main(argv) {
  const options = parseArgs(argv);
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
  const summary = runManifest(manifest, options);

  console.log(
    `e2e-eval-runner: ${summary.passed}/${summary.total} passed, `
    + `${summary.divergences} solver/verifier divergence(s), results ${summary.resultsPath}`,
  );
  if (options.gate && summary.failed > 0) {
    process.exitCode = 1;
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('e2e-eval-runner.mjs');

if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`e2e-eval-runner: ${error.message}`);
    process.exitCode = 1;
  }
}
