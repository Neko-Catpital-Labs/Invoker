#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const trialsPath = path.join(here, 'trials.jsonl');
const tasksPath = path.join(here, 'tasks.json');
const scoresDir = path.join(here, 'scores');

function usage() {
  return `Usage: node docs/evals/task-decomposition/score.mjs [options]

Options:
  --rubric-version <name>      Rubric version name. Defaults to v1.
  --trials <path>              Trial JSONL path. Defaults to trials.jsonl.
  --human-rubric <path>        Optional JSONL entries keyed by trial_id.
  --help                       Print this help.

The scorer never mutates trials.jsonl. Its only write is
scores/<rubric-version>.jsonl.`;
}

function parseArgs(argv) {
  const options = {
    rubricVersion: 'v1',
    trials: trialsPath,
    humanRubric: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      options.help = true;
    } else if (arg === '--rubric-version') {
      options.rubricVersion = argv[++i];
    } else if (arg === '--trials') {
      options.trials = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === '--human-rubric') {
      options.humanRubric = path.resolve(process.cwd(), argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!/^[A-Za-z0-9._-]+$/.test(options.rubricVersion)) {
    throw new Error('--rubric-version may contain only letters, digits, dot, underscore, and hyphen');
  }
  return options;
}

function readJsonl(filePath, missingOk = false) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (missingOk && error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filePath}:${index + 1}: invalid JSONL: ${error.message}`);
      }
    });
}

function loadTaskMap() {
  const tasks = JSON.parse(readFileSync(tasksPath, 'utf8'));
  return new Map(tasks.map((task) => [task.id, task]));
}

function loadHumanEntries(filePath) {
  if (!filePath) {
    return new Map();
  }
  return new Map(readJsonl(filePath).map((entry) => [entry.trial_id, entry]));
}

function runFrozenTest(task) {
  const result = spawnSync(task.deterministic_pass_command, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });

  return {
    command: task.deterministic_pass_command,
    exit_code: result.status,
    signal: result.signal,
    passed: result.status === 0,
    stdout_tail: (result.stdout || '').slice(-4000),
    stderr_tail: (result.stderr || '').slice(-4000),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function llmJudgePlaceholder(trial, rubricVersion) {
  return {
    status: 'not_invoked',
    rubric_version: rubricVersion,
    invocation: {
      trial_id: trial.trial_id,
      arm: trial.arm,
      task_id: trial.task_id,
      output_ref: trial.output_ref,
      instruction: 'Judge task success, solution quality, and evidence quality without mutating trial records.',
    },
  };
}

function humanRubricEntry(trial, humanEntries) {
  const entry = humanEntries.get(trial.trial_id);
  if (!entry) {
    return { status: 'missing', trial_id: trial.trial_id };
  }
  return {
    status: 'recorded',
    trial_id: trial.trial_id,
    reviewer: entry.reviewer ?? null,
    rubric_entry: entry.rubric_entry ?? entry,
  };
}

function outputPathFor(rubricVersion) {
  const out = path.join(scoresDir, `${rubricVersion}.jsonl`);
  const relative = path.relative(scoresDir, out);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resolved score output escaped scores/');
  }
  return out;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const trials = readJsonl(options.trials, true);
  const tasks = loadTaskMap();
  const humanEntries = loadHumanEntries(options.humanRubric);
  const records = trials.map((trial) => {
    const task = tasks.get(trial.task_id);
    if (!task) {
      throw new Error(`Unknown task_id in trial ${trial.trial_id}: ${trial.task_id}`);
    }
    return {
      trial_id: trial.trial_id,
      arm: trial.arm,
      task_id: trial.task_id,
      rubric_version: options.rubricVersion,
      lanes: {
        frozen_test_suite: runFrozenTest(task),
        llm_judge: llmJudgePlaceholder(trial, options.rubricVersion),
        human_rubric: humanRubricEntry(trial, humanEntries),
      },
      timestamp: new Date().toISOString(),
    };
  });

  mkdirSync(scoresDir, { recursive: true });
  const out = outputPathFor(options.rubricVersion);
  writeFileSync(out, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''));
  console.log(JSON.stringify({
    rubric_version: options.rubricVersion,
    trials_read: trials.length,
    scores_written: records.length,
    output: path.relative(repoRoot, out),
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
