#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  DIRECT_CONDITION,
  buildAdapterRow,
  buildSelfTestManifest,
  checkRows,
  createAdapterRunRoot,
  runDirectManifest,
  runVerifier,
  selectTasks,
  truncate,
  writeJsonl,
} from './e2e-eval-direct-agent.mjs';
import { REPO_ROOT, assertOutsideRepoCheckout, loadManifest } from './e2e-eval-runner.mjs';

export const INVOKER_CONDITION = 'invoker';

const SELF_PATH = fileURLToPath(import.meta.url);
const BUILT_CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');

const USAGE = [
  'usage: e2e-eval-invoker-agent.mjs --manifest <path> [--task <id>] [--out <results.jsonl>] [--keep]',
  '       e2e-eval-invoker-agent.mjs --self-test',
  '',
  'Runs eval manifest tasks through isolated Invoker standalone scratch plans,',
  'then grades each persisted executor workspace with the manifest verifier.',
  'The self-test emits paired direct-agent and invoker rows for three tasks.',
].join('\n');

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function safePlanTaskId(taskId) {
  return `eval-${taskId}`.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function invokerHelperSource() {
  return String.raw`#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const truncate = (text) => {
  const value = typeof text === 'string' ? text : '';
  const limit = 8000;
  return value.length <= limit ? value : value.slice(0, limit) + '\n[truncated ' + (value.length - limit) + ' bytes]';
};
for (const [relativePath, contents] of Object.entries(spec.fixtureFiles ?? {})) {
  const destination = path.join(process.cwd(), relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}
const startedAt = Date.now();
const result = spawnSync(spec.solver.command, spec.solver.args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...(spec.solver.env ?? {}),
    INVOKER_EVAL_TASK_ID: spec.taskId,
    INVOKER_EVAL_RUN_ID: spec.runId,
    INVOKER_EVAL_PROMPT: spec.prompt,
    INVOKER_EVAL_MODEL: spec.model,
    INVOKER_EVAL_BUDGET_USD: String(spec.budgetUsd),
    INVOKER_EVAL_WORKDIR: process.cwd(),
  },
  encoding: 'utf8',
  timeout: spec.solverTimeoutMs,
  killSignal: 'SIGKILL',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const durationMs = Date.now() - startedAt;
const timedOut = result.error?.code === 'ETIMEDOUT' || (result.signal === 'SIGKILL' && durationMs >= spec.solverTimeoutMs);
const spawnFailed = Boolean(result.error) && !timedOut;
const summary = {
  exitCode: typeof result.status === 'number' ? result.status : null,
  signal: result.signal ?? null,
  timedOut,
  spawnError: spawnFailed ? result.error.message : null,
  durationMs,
  stdout: truncate(result.stdout),
  stderr: truncate(result.stderr),
};
writeFileSync('.invoker-eval-solver-result.json', JSON.stringify(summary) + '\n');
if (summary.spawnError) process.exit(127);
if (summary.timedOut) process.exit(124);
process.exit(summary.exitCode ?? 1);
`;
}

function writeTempCliIndex(bundleDir) {
  const entryPath = path.join(bundleDir, 'index.js');
  writeFileSync(entryPath, `#!/usr/bin/env node
const argv = process.argv.slice(2);
import('./cli-runtime.mjs').then(async (runtime) => {
  process.exitCode = await runtime.main(argv);
}, (error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\\n');
  process.exitCode = 1;
});
`);
  return entryPath;
}

function buildTempCliEntry(runRoot) {
  const buildRoot = assertOutsideRepoCheckout(path.join(runRoot, 'invoker-cli-build'), 'temporary CLI build root');
  const outDir = path.join(buildRoot, 'dist');
  mkdirSync(buildRoot, { recursive: true });
  const configPath = path.join(buildRoot, 'tsup.config.mjs');
  writeFileSync(configPath, `import { defineConfig } from ${JSON.stringify(path.join(REPO_ROOT, 'node_modules/tsup/dist/index.js'))};
export default defineConfig({
  entry: { 'cli-runtime': ${JSON.stringify(path.join(REPO_ROOT, 'packages/cli/src/cli-runtime.ts'))} },
  format: ['esm'],
  dts: false,
  clean: true,
  removeNodeProtocol: false,
  outDir: ${JSON.stringify(outDir)},
  outExtension: () => ({ js: '.mjs' }),
  external: ['node:sqlite', 'yaml', 'dockerode', 'ssh2', 'cpu-features', '@slack/web-api'],
  noExternal: ['@invoker/contracts', '@invoker/data-store', '@invoker/execution-engine', '@invoker/shell', '@invoker/transport', '@invoker/workflow-core', '@invoker/workflow-graph', 'neverthrow'],
});
`);
  const build = spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsup'), ['--config', configPath], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (build.status !== 0) {
    throw new Error(`failed to build temporary CLI bundle: ${truncate(`${build.stdout ?? ''}${build.stderr ?? ''}`)}`);
  }
  const linkedNodeModules = path.join(buildRoot, 'node_modules');
  if (!existsSync(linkedNodeModules)) symlinkSync(path.join(REPO_ROOT, 'packages/cli/node_modules'), linkedNodeModules, 'dir');
  return writeTempCliIndex(outDir);
}

function resolveCliEntry(runRoot) {
  if (existsSync(BUILT_CLI_ENTRY)) return BUILT_CLI_ENTRY;
  return buildTempCliEntry(runRoot);
}

function buildTaskSpec(task, runId) {
  return {
    taskId: task.id,
    runId,
    prompt: task.prompt,
    model: task.model,
    budgetUsd: task.budgetUsd,
    solverTimeoutMs: task.solverTimeoutMs,
    fixtureFiles: task.fixtureFiles,
    solver: task.solver,
  };
}

function writeInvokerPlan(task, { runId, taskRoot }) {
  const helperPath = path.join(taskRoot, 'run-solver.mjs');
  const specPath = path.join(taskRoot, 'task-spec.json');
  const planPath = path.join(taskRoot, 'plan.yaml');
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(helperPath, invokerHelperSource(), { mode: 0o755 });
  writeFileSync(specPath, JSON.stringify(buildTaskSpec(task, runId), null, 2));
  const command = `${shellQuote(process.execPath)} ${shellQuote(helperPath)} ${shellQuote(specPath)}`;
  writeFileSync(planPath, [
    `name: ${yamlScalar(`e2e eval invoker ${task.id}`)}`,
    'scratch: true',
    'onFinish: none',
    'mergeMode: no_op',
    '',
    'tasks:',
    `  - id: ${yamlScalar(safePlanTaskId(task.id))}`,
    `    description: ${yamlScalar(`Run eval task ${task.id} through Invoker scratch execution`)}`,
    `    command: ${yamlScalar(command)}`,
    '    dependencies: []',
    '',
  ].join('\n'));
  return { helperPath, specPath, planPath };
}

function runInvokerCli(planPath, dbDir, timeoutMs, cliEntry) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [
    cliEntry,
    'run',
    planPath,
    '--standalone',
    '--db-dir',
    dbDir,
    '--json',
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      INVOKER_DB_DIR: dbDir,
      INVOKER_HEADLESS_STANDALONE: '1',
    },
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
    timeoutMs,
    spawnError: spawnFailed ? result.error.message : null,
    durationMs,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
  };
}

function readInvokerTaskState(dbDir, planTaskId) {
  const dbPath = path.join(dbDir, 'invoker.db');
  if (!existsSync(dbPath)) return { error: `expected invoker.db at ${dbPath}` };
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const task = db.prepare(
        'SELECT id, workflow_id AS workflowId, status, runner_kind AS runnerKind, workspace_path AS workspacePath, exit_code AS exitCode, error FROM tasks WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1',
      ).get(`%/${planTaskId}`);
      if (!task) return { error: `expected persisted task ending in /${planTaskId}` };
      const outputRows = db.prepare('SELECT data FROM output_spool WHERE task_id = ? ORDER BY offset ASC, id ASC').all(task.id);
      const legacyRows = db.prepare('SELECT data FROM task_output WHERE task_id = ? ORDER BY id ASC').all(task.id);
      return {
        task: {
          id: String(task.id),
          workflowId: String(task.workflowId),
          status: String(task.status),
          runnerKind: String(task.runnerKind),
          workspacePath: task.workspacePath ? String(task.workspacePath) : '',
          exitCode: typeof task.exitCode === 'number' ? task.exitCode : null,
          error: task.error ? String(task.error) : null,
          output: truncate([...outputRows, ...legacyRows].map((row) => String(row.data ?? '')).join('')),
        },
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readSolverSummary(workspaceDir) {
  const solverPath = path.join(workspaceDir, '.invoker-eval-solver-result.json');
  if (!workspaceDir || !existsSync(solverPath)) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: solverPath ? `missing solver result at ${solverPath}` : 'missing invoker workspace',
      durationMs: null,
      stdout: '',
      stderr: '',
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(solverPath, 'utf8'));
    return {
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
      signal: parsed.signal ?? null,
      timedOut: parsed.timedOut === true,
      spawnError: typeof parsed.spawnError === 'string' ? parsed.spawnError : null,
      durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : null,
      stdout: truncate(parsed.stdout),
      stderr: truncate(parsed.stderr),
    };
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: `could not parse solver result: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: null,
      stdout: '',
      stderr: '',
    };
  }
}

export function runInvokerTask(task, options = {}) {
  const runRoot = options.runRoot ?? createAdapterRunRoot('invoker-e2e-eval-invoker-');
  const runId = options.runId ?? randomUUID();
  const taskRoot = assertOutsideRepoCheckout(path.join(runRoot, INVOKER_CONDITION, task.id), `invoker task root for ${task.id}`);
  const verifierDir = path.join(taskRoot, 'verifier');
  const dbDir = path.join(taskRoot, 'db');
  mkdirSync(verifierDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });

  const planTaskId = safePlanTaskId(task.id);
  const { planPath } = writeInvokerPlan(task, { runId, taskRoot });
  const startedAt = new Date().toISOString();
  const cliEntry = options.cliEntry ?? resolveCliEntry(runRoot);
  const invokerRun = runInvokerCli(planPath, dbDir, task.solverTimeoutMs + task.verifierTimeoutMs + 60_000, cliEntry);
  const state = readInvokerTaskState(dbDir, planTaskId);
  const workspaceDir = state.task?.workspacePath ?? '';
  const missingWorkspace = workspaceDir && existsSync(workspaceDir) ? null : (state.error ?? `missing invoker workspace for ${task.id}`);
  const solver = readSolverSummary(workspaceDir);
  const verifier = missingWorkspace
    ? {
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: missingWorkspace,
      durationMs: 0,
      stdout: '',
      stderr: '',
    }
    : runVerifier(task, { runId, workspaceDir, verifierDir });

  const finishedAt = new Date().toISOString();
  const row = buildAdapterRow({
    condition: INVOKER_CONDITION,
    task,
    runId,
    startedAt,
    finishedAt,
    solver,
    verifier,
    workspaceDir,
    verifierDir,
    invoker: {
      command: [process.execPath, cliEntry, 'run', planPath, '--standalone', '--db-dir', dbDir, '--json'],
      exitCode: invokerRun.exitCode,
      signal: invokerRun.signal,
      timedOut: invokerRun.timedOut,
      timeoutMs: invokerRun.timeoutMs,
      spawnError: invokerRun.spawnError,
      durationMs: invokerRun.durationMs,
      stdout: invokerRun.stdout,
      stderr: invokerRun.stderr,
      workflowId: state.task?.workflowId ?? null,
      taskId: state.task?.id ?? null,
      taskStatus: state.task?.status ?? null,
      runnerKind: state.task?.runnerKind ?? null,
      taskExitCode: state.task?.exitCode ?? null,
      taskError: state.task?.error ?? null,
      taskOutput: state.task?.output ?? '',
      dbDir,
      planPath,
      dbReadError: state.error ?? null,
      missingWorkspace,
    },
  });

  if (options.keep !== true) rmSync(taskRoot, { recursive: true, force: true });
  return row;
}

export function runInvokerManifest(manifest, options = {}) {
  const runId = options.runId ?? randomUUID();
  const runRoot = options.runRoot ?? createAdapterRunRoot('invoker-e2e-eval-invoker-');
  const cliEntry = options.cliEntry ?? resolveCliEntry(runRoot);
  const rows = selectTasks(manifest, options.taskId).map((task) =>
    runInvokerTask(task, { runRoot, runId, keep: options.keep === true, cliEntry }));
  const outPath = writeJsonl(options.outPath ?? path.join(runRoot, 'invoker-results.jsonl'), rows);
  return { runId, runRoot, outPath, rows };
}

function parseArgs(argv) {
  const parsed = { mode: null, manifest: '', taskId: '', outPath: undefined, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--self-test') parsed.mode = 'self-test';
    else if (arg === '--manifest') { parsed.mode = 'run'; parsed.manifest = argv[index + 1] ?? ''; index += 1; }
    else if (arg.startsWith('--manifest=')) { parsed.mode = 'run'; parsed.manifest = arg.slice('--manifest='.length); }
    else if (arg === '--task') { parsed.taskId = argv[index + 1] ?? ''; index += 1; }
    else if (arg.startsWith('--task=')) parsed.taskId = arg.slice('--task='.length);
    else if (arg === '--out') { parsed.outPath = argv[index + 1] ?? ''; index += 1; }
    else if (arg.startsWith('--out=')) parsed.outPath = arg.slice('--out='.length);
    else if (arg === '--keep') parsed.keep = true;
    else if (arg === '--help' || arg === '-h') parsed.mode = 'help';
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (parsed.mode === 'run' && parsed.manifest.trim() === '') throw new Error('--manifest requires a path');
  return parsed;
}

function selfTest() {
  const runRoot = createAdapterRunRoot('invoker-e2e-eval-paired-self-');
  try {
    const manifest = buildSelfTestManifest();
    const runId = randomUUID();
    const direct = runDirectManifest(manifest, {
      runId,
      runRoot,
      outPath: path.join(runRoot, 'direct.jsonl'),
      keep: true,
    });
    const invoker = runInvokerManifest(manifest, {
      runId,
      runRoot,
      outPath: path.join(runRoot, 'invoker.jsonl'),
      keep: true,
    });
    const rows = [...direct.rows, ...invoker.rows].sort((a, b) =>
      a.taskId.localeCompare(b.taskId) || a.condition.localeCompare(b.condition));
    const failures = [
      ...checkRows(direct.rows, { expectedCondition: DIRECT_CONDITION }),
      ...checkRows(invoker.rows, { expectedCondition: INVOKER_CONDITION }),
    ];
    const taskIds = new Set(rows.map((row) => row.taskId));
    for (const taskId of taskIds) {
      const taskRows = rows.filter((row) => row.taskId === taskId);
      if (taskRows.length !== 2) failures.push(`${taskId}: expected paired rows`);
      const conditions = new Set(taskRows.map((row) => row.condition));
      if (!conditions.has(DIRECT_CONDITION) || !conditions.has(INVOKER_CONDITION)) {
        failures.push(`${taskId}: missing direct/invoker condition pair`);
      }
      const models = new Set(taskRows.map((row) => row.model));
      const budgets = new Set(taskRows.map((row) => row.budgetUsd));
      const timeouts = new Set(taskRows.map((row) => row.solverTimeoutMs));
      if (models.size !== 1 || budgets.size !== 1 || timeouts.size !== 1) {
        failures.push(`${taskId}: paired inputs differ`);
      }
    }
    for (const row of rows) console.log(JSON.stringify(row));
    if (failures.length > 0) {
      console.error(`FAIL e2e-eval-invoker-agent self-test: ${failures.length} check(s) failed`);
      for (const failure of failures) console.error(`  - ${failure}`);
      return 1;
    }
    console.log(`PASS e2e-eval-invoker-agent self-test: ${taskIds.size} tasks produced ${rows.length} paired rows`);
    return 0;
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

function runCli(parsed) {
  const result = runInvokerManifest(loadManifest(parsed.manifest), {
    taskId: parsed.taskId || undefined,
    outPath: parsed.outPath,
    keep: parsed.keep,
  });
  for (const row of result.rows) console.log(JSON.stringify(row));
  console.error(`[eval-invoker] results: ${result.outPath}`);
  return result.rows.every((row) => row.passed) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  let exitCode = 0;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.mode === 'self-test') exitCode = selfTest();
    else if (parsed.mode === 'run') exitCode = runCli(parsed);
    else if (parsed.mode === 'help') console.log(USAGE);
    else { console.error(USAGE); exitCode = 2; }
  } catch (error) {
    console.error(`e2e-eval-invoker-agent: ${error.message}`);
    exitCode = 2;
  }
  process.exitCode = exitCode;
}
