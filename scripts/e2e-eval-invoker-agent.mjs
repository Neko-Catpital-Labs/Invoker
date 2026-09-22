#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
} from './e2e-eval-runner.mjs';
import {
  ADAPTER_ATTEMPTS_FILE,
  DEFAULT_MAX_RETRIES,
  DIRECT_CONDITION,
  REPO_ROOT,
  adapterSmokeManifest,
  assertAdapterSmokeRows,
  runConditionManifest,
  runDirectManifest,
} from './e2e-eval-direct-agent.mjs';

export const INVOKER_CONDITION = 'invoker';

const __filename = fileURLToPath(import.meta.url);
const DIRECT_SCRIPT = resolve(dirname(__filename), 'e2e-eval-direct-agent.mjs');

const USAGE = [
  'usage: e2e-eval-invoker-agent.mjs --manifest <path> [--task <id>]... [--results <path>]',
  '                                   [--model <id>] [--budget-usd <n>] [--max-retries <n>]',
  '                                   [--run-id <id>] [--keep]',
  '       e2e-eval-invoker-agent.mjs --self-test',
  '',
  'Runs eval tasks through an isolated standalone Invoker plan. The self-test',
  'emits paired direct-agent and Invoker rows for the same three smoke tasks.',
].join('\n');

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'task';
}

function patchNodeBuiltinAliases(path) {
  let text = readFileSync(path, 'utf8');
  text = text
    .replaceAll('require("sea")', 'require("node:sea")')
    .replaceAll("require('sea')", 'require("node:sea")')
    .replaceAll(' from "sea"', ' from "node:sea"')
    .replaceAll(" from 'sea'", " from 'node:sea'");
  writeFileSync(path, text);
}

function buildTempInvokerCli(stage) {
  const entryPath = join(stage, 'index.ts');
  const bundlePath = join(stage, 'index.js');
  writeFileSync(entryPath, [
    `import { main } from ${JSON.stringify(resolve(REPO_ROOT, 'packages/cli/src/index.ts').replaceAll('\\', '/'))};`,
    '',
    'void main().then((exitCode) => {',
    '  process.exitCode = exitCode;',
    '});',
    '',
  ].join('\n'));

  const result = spawnSync(resolve(REPO_ROOT, 'node_modules/.bin/tsup'), [
    entryPath,
    '--format',
    'cjs',
    '--platform',
    'node',
    '--target',
    'node26',
    '--no-dts',
    '--no-splitting',
    '--no-config',
    '--out-dir',
    stage,
    '--external',
    'node:sqlite',
    '--external',
    'dockerode',
    '--external',
    'ssh2',
    '--external',
    'cpu-features',
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: MAX_PROCESS_BUFFER_BYTES,
  });

  if (result.status !== 0) {
    throw new Error(
      'failed to build temporary invoker CLI bundle\n'
      + `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  patchNodeBuiltinAliases(bundlePath);
  return bundlePath;
}

function writePlan({ stage, taskId, workspace, command }) {
  const planPath = join(stage, `${safeId(taskId)}.yaml`);
  const plan = [
    `name: ${yamlString(`e2e-eval-${safeId(taskId)}`)}`,
    'onFinish: none',
    'mergeMode: no_op',
    'scratch: true',
    '',
    'tasks:',
    `  - id: ${yamlString(`eval-${safeId(taskId)}`)}`,
    `    description: ${yamlString(`Run eval task ${taskId} through isolated Invoker standalone mode`)}`,
    `    command: ${yamlString(`cd ${shellQuote(workspace)} && ${command}`)}`,
    '    dependencies: []',
    '',
  ].join('\n');
  writeFileSync(planPath, plan);
  return planPath;
}

function executeInvokerPlan(payload) {
  const spec = typeof payload === 'string' ? decodeJson(payload) : payload;
  const workspace = spec.workspace && spec.workspace !== '.' ? spec.workspace : process.env.EVAL_WORKSPACE;
  if (!workspace) throw new Error('invoker adapter requires EVAL_WORKSPACE');
  const stage = mkdtempSync(join(tmpdir(), `invoker-e2e-eval-invoker-${safeId(spec.taskId)}-`));
  try {
    const cliPath = buildTempInvokerCli(stage);
    const attemptsPath = join(workspace, ADAPTER_ATTEMPTS_FILE);
    const directPayload = encodeJson({
      condition: INVOKER_CONDITION,
      run: spec.run,
      timeoutMs: spec.timeoutMs,
      maxRetries: spec.maxRetries,
    });
    const command = [
      `E2E_EVAL_ATTEMPTS_PATH=${shellQuote(attemptsPath)}`,
      shellQuote(process.execPath),
      shellQuote(DIRECT_SCRIPT),
      '--execute-command',
      shellQuote(directPayload),
    ].join(' ');
    const planPath = writePlan({
      stage,
      taskId: spec.taskId,
      workspace,
      command,
    });
    mkdirSync(join(stage, 'db'), { recursive: true });
    const result = spawnSync(process.execPath, [
      cliPath,
      'run',
      planPath,
      '--standalone',
      '--db-dir',
      join(stage, 'db'),
      '--json',
    ], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        EVAL_WORKSPACE: workspace,
        EVAL_MODEL: spec.model,
        EVAL_BUDGET_USD: String(spec.budgetUsd),
      },
      timeout: spec.timeoutMs,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      maxBuffer: MAX_PROCESS_BUFFER_BYTES,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error?.code === 'ETIMEDOUT') return 124;
    if (result.error) {
      process.stderr.write(`invoker adapter spawn error: ${result.error.message}\n`);
      return 127;
    }
    return typeof result.status === 'number' ? result.status : 1;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function invokerSolveRun(task, options = {}) {
  return {
    run: [
      process.execPath,
      __filename,
      '--execute-invoker-plan',
      encodeJson({
        taskId: task.id,
        run: task.solve.run,
        timeoutMs: task.solve.timeoutMs,
        maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
        model: task.model,
        budgetUsd: task.budgetUsd,
        workspace: process.env.EVAL_WORKSPACE || '.',
      }),
    ],
    timeoutMs: task.solve.timeoutMs,
    env: task.solve.env,
  };
}

export function runInvokerManifest(manifest, options = {}) {
  return runConditionManifest(manifest, {
    ...options,
    condition: options.condition ?? INVOKER_CONDITION,
    adaptSolve: invokerSolveRun,
  });
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

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function assertPairedRows(rows) {
  const failures = [];
  const check = (label, condition, detail = '') => {
    if (!condition) failures.push(detail ? `${label} (${detail})` : label);
  };
  check('six paired rows emitted', rows.length === 6, `got ${rows.length}`);
  const byPair = new Map(rows.map((row) => [`${row.condition}:${row.taskId}`, row]));
  for (const taskId of ['direct-write-pass', 'claim-only-fails', 'interruption-recovers']) {
    const direct = byPair.get(`${DIRECT_CONDITION}:${taskId}`);
    const invoker = byPair.get(`${INVOKER_CONDITION}:${taskId}`);
    check(`${taskId} direct row exists`, Boolean(direct));
    check(`${taskId} invoker row exists`, Boolean(invoker));
    if (direct && invoker) {
      check(`${taskId} matched prompt`, direct.prompt === invoker.prompt);
      check(`${taskId} matched model`, direct.model === invoker.model, `${direct.model} vs ${invoker.model}`);
      check(`${taskId} matched budget`, direct.budgetUsd === invoker.budgetUsd, `${direct.budgetUsd} vs ${invoker.budgetUsd}`);
      check(`${taskId} both have verifier output`, typeof direct.verifierOutput.stdout === 'string' && typeof invoker.verifierOutput.stdout === 'string');
    }
  }
  check('direct interruption recovery classified', byPair.get(`${DIRECT_CONDITION}:interruption-recovers`)?.interruptionRecovered === true);
  check('invoker interruption recovery classified', byPair.get(`${INVOKER_CONDITION}:interruption-recovers`)?.interruptionRecovered === true);
  if (failures.length > 0) {
    throw new Error(`paired adapter assertions failed:\n  - ${failures.join('\n  - ')}`);
  }
}

export function selfTest() {
  const before = checkoutSnapshot();
  const manifest = parseManifest(adapterSmokeManifest(), 'paired-adapter-self-test');
  const workDir = mkdtempSync(join(tmpdir(), 'invoker-e2e-eval-paired-selftest-'));
  try {
    const directPath = join(workDir, 'direct.jsonl');
    const invokerPath = join(workDir, 'invoker.jsonl');
    const direct = runDirectManifest(manifest, {
      runId: 'paired-direct-self-test',
      resultsPath: directPath,
      quiet: true,
      maxRetries: DEFAULT_MAX_RETRIES,
    });
    const invoker = runInvokerManifest(manifest, {
      runId: 'paired-invoker-self-test',
      resultsPath: invokerPath,
      quiet: true,
      maxRetries: DEFAULT_MAX_RETRIES,
    });
    assertAdapterSmokeRows(direct.rows, DIRECT_CONDITION);
    assertAdapterSmokeRows(invoker.rows, INVOKER_CONDITION);
    const rows = [...readJsonl(directPath), ...readJsonl(invokerPath)];
    assertPairedRows(rows);
    const after = checkoutSnapshot();
    if (before !== after) throw new Error('source checkout changed during paired adapter self-test');

    for (const row of rows) {
      const verifierLine = (row.verifierOutput.stdout || row.verifierOutput.stderr || '').split('\n').find((line) => line.trim()) ?? '';
      console.log(JSON.stringify({
        taskId: row.taskId,
        condition: row.condition,
        attempt: row.attempt,
        passed: row.passed,
        durationMs: row.durationMs,
        retries: row.retries,
        humanRescue: row.humanRescue,
        infrastructureFailure: row.infrastructureFailure,
        interruptionRecovered: row.interruptionRecovered,
        verifierOutput: verifierLine.trim(),
      }));
    }
    console.log(`PASS e2e-eval-invoker-agent self-test: ${rows.length} paired rows across 3 tasks`);
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
    if (arg === '--execute-invoker-plan') parsed.executeInvokerPlan = next();
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
  if (options.executeInvokerPlan) {
    process.exitCode = executeInvokerPlan(options.executeInvokerPlan);
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
  const summary = runInvokerManifest(manifest, options);
  console.log(`e2e-eval-invoker-agent: ${summary.passed}/${summary.total} passed, results ${summary.resultsPath}`);
  if (summary.failed > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`e2e-eval-invoker-agent: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
