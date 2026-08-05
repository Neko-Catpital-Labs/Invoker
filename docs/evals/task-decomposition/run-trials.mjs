#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARMS = new Set(['split', 'monolithic']);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const tasksPath = path.join(here, 'tasks.json');
const promptsPath = path.join(here, 'golden-prompts.md');
const trialsPath = path.join(here, 'trials.jsonl');
const outputsDir = path.join(here, 'outputs');

function usage() {
  return `Usage: node docs/evals/task-decomposition/run-trials.mjs [options]

Options:
  --arm split|monolithic   Limit to one experiment arm. Defaults to both arms.
  --task <id>              Limit to one task id. Defaults to all tasks.
  --trials N               Trial count per selected arm/task. Defaults to 1.
  --dry-run                Validate config and print the planned matrix only.
  --help                   Print this help.

Live trial execution is intentionally adapter-based. For non-dry runs, set
TASK_DECOMPOSITION_AGENT_COMMAND to a command that accepts a JSON invocation spec
on stdin and writes trial output on stdout.`;
}

function parseArgs(argv) {
  const options = {
    arm: null,
    task: null,
    trials: 1,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help') {
      options.help = true;
    } else if (arg === '--arm') {
      options.arm = argv[++i];
    } else if (arg === '--task') {
      options.task = argv[++i];
    } else if (arg === '--trials') {
      options.trials = Number(argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.arm && !ARMS.has(options.arm)) {
    throw new Error(`--arm must be one of: ${[...ARMS].join(', ')}`);
  }
  if (!Number.isInteger(options.trials) || options.trials < 1) {
    throw new Error('--trials must be a positive integer');
  }
  return options;
}

function loadTasks() {
  const tasks = JSON.parse(readFileSync(tasksPath, 'utf8'));
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('tasks.json must contain a non-empty array');
  }

  const seen = new Set();
  for (const task of tasks) {
    for (const key of ['id', 'repro_script_path', 'description', 'deterministic_pass_command']) {
      if (typeof task[key] !== 'string' || task[key].trim() === '') {
        throw new Error(`Task is missing required string field: ${key}`);
      }
    }
    if (seen.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    seen.add(task.id);
  }
  return tasks;
}

function loadPrompt(markdown, taskId, arm) {
  const start = `<!-- prompt:${taskId}:${arm}:start -->`;
  const end = `<!-- prompt:${taskId}:${arm}:end -->`;
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error(`Missing frozen prompt for ${taskId}/${arm}`);
  }
  return markdown.slice(startIndex + start.length, endIndex).trim();
}

function buildMatrix(tasks, options) {
  const selectedTasks = options.task
    ? tasks.filter((task) => task.id === options.task)
    : tasks;
  if (options.task && selectedTasks.length === 0) {
    throw new Error(`Unknown task id: ${options.task}`);
  }

  const selectedArms = options.arm ? [options.arm] : [...ARMS];
  const prompts = readFileSync(promptsPath, 'utf8');
  const matrix = [];
  for (const task of selectedTasks) {
    for (const arm of selectedArms) {
      const prompt = loadPrompt(prompts, task.id, arm);
      for (let trialNumber = 1; trialNumber <= options.trials; trialNumber += 1) {
        matrix.push({ task, arm, prompt, trialNumber });
      }
    }
  }
  return matrix;
}

function printDryRun(matrix) {
  const planned = matrix.map(({ task, arm, prompt, trialNumber }) => ({
    trial_number: trialNumber,
    arm,
    task_id: task.id,
    description: task.description,
    repro_script_path: task.repro_script_path,
    deterministic_pass_command: task.deterministic_pass_command,
    prompt_chars: prompt.length,
  }));

  console.log(JSON.stringify({
    dry_run: true,
    agent_invocations: 0,
    trial_count: planned.length,
    matrix: planned,
  }, null, 2));
}

function runAdapter(invocation) {
  const command = process.env.TASK_DECOMPOSITION_AGENT_COMMAND;
  if (!command) {
    throw new Error('Non-dry runs require TASK_DECOMPOSITION_AGENT_COMMAND');
  }

  const started = Date.now();
  const result = spawnSync(command, {
    input: `${JSON.stringify(invocation, null, 2)}\n`,
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 50 * 1024 * 1024,
  });
  const wallClockMs = Date.now() - started;
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error ? String(result.error.message || result.error) : null,
    wall_clock_ms: wallClockMs,
  };
}

function appendTrial({ task, arm, prompt, trialNumber }) {
  const trialId = `${Date.now()}-${arm}-${task.id}-${trialNumber}-${randomUUID()}`;
  const outputRef = path.join('outputs', `${trialId}.json`);
  const invocation = {
    trial_id: trialId,
    arm,
    task,
    prompt,
    expected_execution_model: arm === 'split'
      ? 'plan then execute via Invoker task DAG'
      : 'one agent, one prompt',
  };

  const adapterResult = runAdapter(invocation);
  mkdirSync(outputsDir, { recursive: true });
  writeFileSync(path.join(here, outputRef), `${JSON.stringify({
    trial_id: trialId,
    invocation,
    adapter_result: adapterResult,
  }, null, 2)}\n`);

  const record = {
    trial_id: trialId,
    arm,
    task_id: task.id,
    prompt,
    output_ref: outputRef,
    cost: {
      total: null,
      decompose_overhead: arm === 'split' ? null : 0,
      autofix: null,
      wall_clock_ms: adapterResult.wall_clock_ms,
    },
    timestamp: new Date().toISOString(),
  };
  appendFileSync(trialsPath, `${JSON.stringify(record)}\n`);
  return record;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const tasks = loadTasks();
  const matrix = buildMatrix(tasks, options);
  if (options.dryRun) {
    printDryRun(matrix);
    return;
  }

  const records = matrix.map((entry) => appendTrial(entry));
  console.log(JSON.stringify({
    dry_run: false,
    trials_jsonl: path.relative(repoRoot, trialsPath),
    records_written: records.length,
    trial_ids: records.map((record) => record.trial_id),
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
