#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  GRADE_SOURCE,
  MAX_CAPTURED_OUTPUT,
  REPO_ROOT,
  RESULT_SCHEMA_VERSION,
  assertOutsideRepoCheckout,
  loadManifest,
  normalizeManifest,
} from './e2e-eval-runner.mjs';

export const ADAPTER_RESULT_SCHEMA_VERSION = 1;
export const DIRECT_CONDITION = 'direct-agent';

const SELF_PATH = fileURLToPath(import.meta.url);

const USAGE = [
  'usage: e2e-eval-direct-agent.mjs --manifest <path> [--task <id>] [--out <results.jsonl>] [--keep]',
  '       e2e-eval-direct-agent.mjs --self-test',
  '',
  'Runs eval manifest tasks directly in disposable workspaces and grades the',
  'result with the manifest verifier. Adapter rows include condition, attempt,',
  'pass/fail, retry/human-rescue placeholders, and failure classification.',
].join('\n');

export function truncate(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= MAX_CAPTURED_OUTPUT) return value;
  return `${value.slice(0, MAX_CAPTURED_OUTPUT)}\n[truncated ${value.length - MAX_CAPTURED_OUTPUT} bytes]`;
}

export function materializeFiles(rootDir, files) {
  for (const [relativePath, contents] of Object.entries(files ?? {})) {
    const destination = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
}

export function runCommandSync(spec, { cwd, env, timeoutMs }) {
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

export function createAdapterRunRoot(prefix = 'invoker-e2e-eval-adapter-') {
  return assertOutsideRepoCheckout(mkdtempSync(path.join(tmpdir(), prefix)), 'adapter run root');
}

export function commandVector(spec) {
  return [spec.command, ...(spec.args ?? [])];
}

export function solverEnvForTask(task, runId, workspaceDir, extra = {}) {
  return {
    ...process.env,
    ...task.solver.env,
    ...extra,
    INVOKER_EVAL_TASK_ID: task.id,
    INVOKER_EVAL_RUN_ID: runId,
    INVOKER_EVAL_PROMPT: task.prompt,
    INVOKER_EVAL_MODEL: task.model,
    INVOKER_EVAL_BUDGET_USD: String(task.budgetUsd),
    INVOKER_EVAL_WORKDIR: workspaceDir,
  };
}

export function runVerifier(task, { runId, workspaceDir, verifierDir }) {
  materializeFiles(verifierDir, task.verifier.files);
  return runCommandSync(task.verifier, {
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
}

export function gradeFromVerifier(verifier, verifierTimeoutMs) {
  if (verifier.timedOut) {
    return { passed: false, graded: 'fail', gradeReason: `verifier timed out after ${verifierTimeoutMs}ms` };
  }
  if (verifier.spawnError) {
    return { passed: false, graded: 'fail', gradeReason: `verifier failed to start: ${verifier.spawnError}` };
  }
  if (verifier.exitCode === 0) {
    return { passed: true, graded: 'pass', gradeReason: 'verifier exited 0' };
  }
  return { passed: false, graded: 'fail', gradeReason: `verifier exited ${verifier.exitCode}` };
}

export function classifyInfrastructureFailure({ solver, verifier, invoker }) {
  if (verifier?.spawnError) return { kind: 'verifier-spawn', message: verifier.spawnError };
  if (solver?.spawnError) return { kind: 'solver-spawn', message: solver.spawnError };
  if (invoker?.spawnError) return { kind: 'invoker-spawn', message: invoker.spawnError };
  if (invoker?.missingWorkspace) return { kind: 'invoker-missing-workspace', message: invoker.missingWorkspace };
  if (invoker?.dbReadError) return { kind: 'invoker-db-read', message: invoker.dbReadError };
  return null;
}

export function classifyInterruptionRecovery({ solver, verifier, invoker, passed }) {
  if (solver?.timedOut) {
    return { kind: 'solver-timeout', recoveredByVerifier: passed, verifierExitCode: verifier?.exitCode ?? null };
  }
  if (invoker?.timedOut) {
    return { kind: 'invoker-timeout', recoveredByVerifier: false, verifierExitCode: verifier?.exitCode ?? null };
  }
  if (verifier?.timedOut) {
    return { kind: 'verifier-timeout', recoveredByVerifier: false, verifierExitCode: null };
  }
  return { kind: 'none', recoveredByVerifier: false, verifierExitCode: verifier?.exitCode ?? null };
}

export function buildAdapterRow({
  condition,
  task,
  runId,
  attempt = 1,
  startedAt,
  finishedAt = new Date().toISOString(),
  solver,
  verifier,
  workspaceDir,
  verifierDir,
  invoker = undefined,
}) {
  const grade = gradeFromVerifier(verifier, task.verifierTimeoutMs);
  const startedMs = Date.parse(startedAt);
  const finishedMs = Date.parse(finishedAt);
  return {
    adapterResultSchemaVersion: ADAPTER_RESULT_SCHEMA_VERSION,
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    runId,
    taskId: task.id,
    condition,
    attempt,
    startedAt,
    finishedAt,
    durationMs: Number.isNaN(startedMs) || Number.isNaN(finishedMs) ? null : Math.max(0, finishedMs - startedMs),
    model: task.model,
    budgetUsd: task.budgetUsd,
    solverTimeoutMs: task.solverTimeoutMs,
    verifierTimeoutMs: task.verifierTimeoutMs,
    passed: grade.passed,
    graded: grade.graded,
    gradeSource: GRADE_SOURCE,
    gradeReason: grade.gradeReason,
    gradeIgnoredSolverOutcome: true,
    retries: 0,
    humanRescue: false,
    infrastructureFailure: classifyInfrastructureFailure({ solver, verifier, invoker }),
    interruptionRecovery: classifyInterruptionRecovery({ solver, verifier, invoker, passed: grade.passed }),
    solver: {
      command: commandVector(task.solver),
      exitCode: solver?.exitCode ?? null,
      signal: solver?.signal ?? null,
      timedOut: solver?.timedOut ?? false,
      timeoutMs: task.solverTimeoutMs,
      spawnError: solver?.spawnError ?? null,
      durationMs: solver?.durationMs ?? null,
      stdout: solver?.stdout ?? '',
      stderr: solver?.stderr ?? '',
    },
    verifier: {
      command: commandVector(task.verifier),
      exitCode: verifier.exitCode,
      signal: verifier.signal,
      timedOut: verifier.timedOut,
      timeoutMs: task.verifierTimeoutMs,
      spawnError: verifier.spawnError,
      durationMs: verifier.durationMs,
      stdout: verifier.stdout,
      stderr: verifier.stderr,
    },
    invoker: invoker ?? null,
    workspaceDir,
    verifierDir,
  };
}

export function runDirectTask(task, options = {}) {
  const runRoot = options.runRoot ?? createAdapterRunRoot('invoker-e2e-eval-direct-');
  const runId = options.runId ?? randomUUID();
  const condition = options.condition ?? DIRECT_CONDITION;
  const taskRoot = assertOutsideRepoCheckout(path.join(runRoot, condition, task.id), `direct task root for ${task.id}`);
  const workspaceDir = path.join(taskRoot, 'workspace');
  const verifierDir = path.join(taskRoot, 'verifier');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(verifierDir, { recursive: true });
  materializeFiles(workspaceDir, task.fixtureFiles);

  const startedAt = new Date().toISOString();
  const solver = runCommandSync(task.solver, {
    cwd: workspaceDir,
    env: solverEnvForTask(task, runId, workspaceDir),
    timeoutMs: task.solverTimeoutMs,
  });
  const verifier = runVerifier(task, { runId, workspaceDir, verifierDir });
  const row = buildAdapterRow({
    condition,
    task,
    runId,
    startedAt,
    solver,
    verifier,
    workspaceDir,
    verifierDir,
  });

  if (options.keep !== true) rmSync(taskRoot, { recursive: true, force: true });
  return row;
}

export function selectTasks(manifest, taskId) {
  const selected = taskId ? manifest.tasks.filter((task) => task.id === taskId) : manifest.tasks;
  if (selected.length === 0) throw new Error(`no task matches --task ${taskId}`);
  return selected;
}

export function writeJsonl(outPath, rows) {
  const resolved = assertOutsideRepoCheckout(outPath, 'adapter results path');
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return resolved;
}

export function runDirectManifest(manifest, options = {}) {
  const runId = options.runId ?? randomUUID();
  const runRoot = options.runRoot ?? createAdapterRunRoot('invoker-e2e-eval-direct-');
  const rows = selectTasks(manifest, options.taskId).map((task) =>
    runDirectTask(task, { runRoot, runId, keep: options.keep === true }));
  const outPath = writeJsonl(options.outPath ?? path.join(runRoot, 'direct-agent-results.jsonl'), rows);
  return { runId, runRoot, outPath, rows };
}

export function buildSelfTestManifest() {
  return normalizeManifest({
    schemaVersion: 1,
    name: 'e2e-eval-adapter smoke',
    defaults: {
      model: 'adapter-smoke-model',
      budgetUsd: 0.03,
      solverTimeoutMs: 2_000,
      verifierTimeoutMs: 30_000,
    },
    tasks: [
      {
        id: 'write-answer',
        prompt: 'Write the exact word hello to answer.txt.',
        fixture: { files: { 'answer.txt': 'wrong\n' } },
        solver: { command: 'bash', args: ['-c', 'printf hello > answer.txt; echo solver: wrote-answer'] },
        verifier: {
          command: 'bash',
          args: ['-c', '[ "$(cat "$INVOKER_EVAL_WORKDIR/answer.txt")" = "hello" ] && echo "verifier: write-answer passed"'],
        },
      },
      {
        id: 'matched-inputs',
        prompt: 'Record the provided task id, model, and budget.',
        solver: {
          command: 'bash',
          args: ['-c', 'printf "%s\\n%s\\n%s\\n" "$INVOKER_EVAL_TASK_ID" "$INVOKER_EVAL_MODEL" "$INVOKER_EVAL_BUDGET_USD" > inputs.txt; echo solver: matched-inputs'],
        },
        verifier: {
          command: 'bash',
          args: ['-c', 'grep -qx "$INVOKER_EVAL_TASK_ID" "$INVOKER_EVAL_WORKDIR/inputs.txt" && grep -qx "adapter-smoke-model" "$INVOKER_EVAL_WORKDIR/inputs.txt" && grep -qx "0.03" "$INVOKER_EVAL_WORKDIR/inputs.txt" && echo "verifier: matched-inputs passed"'],
        },
      },
      {
        id: 'timeout-after-final-state',
        prompt: 'Write recovered to recovered.txt, then simulate an interrupted agent.',
        solverTimeoutMs: 900,
        solver: { command: 'bash', args: ['-c', 'printf recovered > recovered.txt; echo solver: final-state-written; sleep 30'] },
        verifier: {
          command: 'bash',
          args: ['-c', '[ "$(cat "$INVOKER_EVAL_WORKDIR/recovered.txt")" = "recovered" ] && echo "verifier: timeout recovery passed"'],
        },
      },
    ],
  }, 'adapter-self-test');
}

export function checkRows(rows, { expectedCondition, expectedCount = 3 } = {}) {
  const failures = [];
  const check = (label, condition) => { if (!condition) failures.push(label); };
  check(`expected ${expectedCount} rows`, rows.length === expectedCount);
  for (const row of rows) {
    check(`${row.taskId}: condition is ${expectedCondition}`, !expectedCondition || row.condition === expectedCondition);
    check(`${row.taskId}: attempt is 1`, row.attempt === 1);
    check(`${row.taskId}: passed is boolean`, typeof row.passed === 'boolean');
    check(`${row.taskId}: duration is recorded`, typeof row.durationMs === 'number' && row.durationMs >= 0);
    check(`${row.taskId}: verifier output is present`, `${row.verifier?.stdout ?? ''}${row.verifier?.stderr ?? ''}`.includes('verifier:'));
    check(`${row.taskId}: no human rescue`, row.humanRescue === false);
    check(`${row.taskId}: retries recorded`, row.retries === 0);
    check(`${row.taskId}: model and budget recorded`, row.model === 'adapter-smoke-model' && row.budgetUsd === 0.03);
    check(`${row.taskId}: workspace outside source checkout`, typeof row.workspaceDir === 'string' && path.relative(REPO_ROOT, row.workspaceDir).startsWith('..'));
  }
  const timeout = rows.find((row) => row.taskId === 'timeout-after-final-state');
  check('timeout task classified as solver-timeout', timeout?.interruptionRecovery?.kind === 'solver-timeout');
  check('timeout task recovered by verifier', timeout?.interruptionRecovery?.recoveredByVerifier === true);
  check('all smoke tasks passed verifier', rows.every((row) => row.passed === true));
  return failures;
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
  const runRoot = createAdapterRunRoot('invoker-e2e-eval-direct-self-');
  try {
    const result = runDirectManifest(buildSelfTestManifest(), { runRoot, outPath: path.join(runRoot, 'direct.jsonl') });
    const failures = checkRows(result.rows, { expectedCondition: DIRECT_CONDITION });
    for (const row of result.rows) console.log(JSON.stringify(row));
    if (failures.length > 0) {
      console.error(`FAIL e2e-eval-direct-agent self-test: ${failures.length} check(s) failed`);
      for (const failure of failures) console.error(`  - ${failure}`);
      return 1;
    }
    console.log(`PASS e2e-eval-direct-agent self-test: ${result.rows.length} direct-agent rows verified`);
    return 0;
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

function runCli(parsed) {
  const result = runDirectManifest(loadManifest(parsed.manifest), {
    taskId: parsed.taskId || undefined,
    outPath: parsed.outPath,
    keep: parsed.keep,
  });
  for (const row of result.rows) console.log(JSON.stringify(row));
  console.error(`[eval-direct] results: ${result.outPath}`);
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
    console.error(`e2e-eval-direct-agent: ${error.message}`);
    exitCode = 2;
  }
  process.exitCode = exitCode;
}
