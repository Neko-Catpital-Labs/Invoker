#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const VALID_GATE_POLICIES = new Set(['completed', 'review_ready']);

function usage() {
  return `Usage: node scripts/check-workflow-consistency.mjs [--db <path>] [--repair] [--json]\n\nChecks persisted workflow rows for state-invariant problems.\n`;
}

function parseArgs(argv) {
  const opts = {
    db: join(process.env.INVOKER_DB_DIR || join(homedir(), '.invoker'), 'invoker.db'),
    repair: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      const value = argv[i + 1];
      if (!value) throw new Error('--db requires a path');
      opts.db = value;
      i += 1;
    } else if (arg === '--repair') {
      opts.repair = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  opts.db = resolve(opts.db);
  return opts;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function dependencyKey(dep) {
  return `${dep.workflowId}\u0000${dep.taskId ?? ''}`;
}

function validateDependency(dep, path, problems) {
  if (!isRecord(dep)) {
    problems.push(`${path} must be an object`);
    return;
  }
  if (!nonEmptyString(dep.workflowId)) {
    problems.push(`${path}.workflowId must be a non-empty string`);
  }
  if (Object.prototype.hasOwnProperty.call(dep, 'taskId') && dep.taskId !== undefined && !nonEmptyString(dep.taskId)) {
    problems.push(`${path}.taskId must be a non-empty string when present`);
  }
  if (dep.requiredStatus !== 'completed') {
    problems.push(`${path}.requiredStatus must be completed`);
  }
  if (Object.prototype.hasOwnProperty.call(dep, 'gatePolicy') && dep.gatePolicy !== undefined && !VALID_GATE_POLICIES.has(String(dep.gatePolicy))) {
    problems.push(`${path}.gatePolicy must be completed or review_ready`);
  }
}

function validateDependencyChange(change, path, problems) {
  if (!isRecord(change)) {
    problems.push(`${path} must be an object`);
    return;
  }
  const hasBefore = Object.prototype.hasOwnProperty.call(change, 'before') && change.before !== undefined;
  const hasAfter = Object.prototype.hasOwnProperty.call(change, 'after') && change.after !== undefined;
  if (!hasBefore && !hasAfter) {
    problems.push(`${path} must include before or after`);
  }
  if (hasBefore) validateDependency(change.before, `${path}.before`, problems);
  if (hasAfter) validateDependency(change.after, `${path}.after`, problems);
  if (!nonEmptyString(change.changedAt) || Number.isNaN(Date.parse(change.changedAt))) {
    problems.push(`${path}.changedAt must be a valid date string`);
  }
}

function parseJsonColumn(raw, workflowId, column, problems) {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || raw.length === 0) {
    problems.push({ workflowId, type: 'malformed_json', column, message: `${column} is not valid JSON text` });
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    problems.push({ workflowId, type: 'malformed_json', column, message: `${column} contains malformed JSON: ${err instanceof Error ? err.message : String(err)}` });
    return { ok: false };
  }
}

function tableColumns(db, tableName) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => String(row.name)));
  } catch {
    return new Set();
  }
}

function hasTable(db, tableName) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName);
  return row !== undefined;
}

function addProblem(problems, workflowId, type, column, message, repairable = false) {
  problems.push({ workflowId, type, column, message, repairable, repaired: false });
}

function generationIsInvalid(value) {
  return !Number.isInteger(value) || value < 0;
}

function selectWorkflowRows(db, columns) {
  const fields = ['id'];
  fields.push(columns.has('name') ? 'name' : 'NULL AS name');
  fields.push(columns.has('generation') ? 'generation' : 'NULL AS generation');
  fields.push(columns.has('external_dependencies') ? 'external_dependencies' : 'NULL AS external_dependencies');
  fields.push(columns.has('external_dependency_changes') ? 'external_dependency_changes' : 'NULL AS external_dependency_changes');
  return db.prepare(`SELECT ${fields.join(', ')} FROM workflows ORDER BY id`).all();
}

function validateWorkflowRows(db, columns, opts, problems, repairs) {
  if (!columns.has('generation')) {
    addProblem(problems, '*', 'missing_generation_column', 'generation', 'workflows.generation column is missing', true);
    if (opts.repair) {
      db.exec('ALTER TABLE workflows ADD COLUMN generation INTEGER DEFAULT 0');
      repairs.push({ workflowId: '*', type: 'missing_generation_column', column: 'generation', action: 'added generation column with default 0' });
      columns.add('generation');
      problems[problems.length - 1].repaired = true;
    }
  }

  const rows = selectWorkflowRows(db, columns);
  const dependencyKeysByWorkflow = new Map();
  for (const row of rows) {
    const workflowId = String(row.id ?? '');
    if (generationIsInvalid(row.generation)) {
      addProblem(problems, workflowId, 'invalid_generation', 'generation', `generation must be an integer >= 0, got ${JSON.stringify(row.generation)}`, true);
      if (opts.repair && columns.has('generation')) {
        db.prepare('UPDATE workflows SET generation = 0 WHERE id = ?').run(workflowId);
        repairs.push({ workflowId, type: 'invalid_generation', column: 'generation', action: 'set generation to 0' });
        problems[problems.length - 1].repaired = true;
      }
    }

    const depsParsed = parseJsonColumn(row.external_dependencies, workflowId, 'external_dependencies', problems);
    if (depsParsed.ok && depsParsed.value !== undefined) {
      if (!Array.isArray(depsParsed.value)) {
        addProblem(problems, workflowId, 'invalid_dependency_entries', 'external_dependencies', 'external_dependencies must be an array when present');
      } else if (depsParsed.value.length === 0) {
        addProblem(problems, workflowId, 'empty_external_dependencies', 'external_dependencies', 'external_dependencies must be non-empty when present', true);
        if (opts.repair && columns.has('external_dependencies')) {
          db.prepare('UPDATE workflows SET external_dependencies = NULL WHERE id = ?').run(workflowId);
          repairs.push({ workflowId, type: 'empty_external_dependencies', column: 'external_dependencies', action: 'normalized [] to NULL' });
          problems[problems.length - 1].repaired = true;
        }
      } else {
        const validationErrors = [];
        depsParsed.value.forEach((dep, index) => validateDependency(dep, `external_dependencies[${index}]`, validationErrors));
        if (validationErrors.length > 0) {
          addProblem(problems, workflowId, 'invalid_dependency_entries', 'external_dependencies', validationErrors.join('; '));
        } else {
          dependencyKeysByWorkflow.set(workflowId, new Set(depsParsed.value.map(dependencyKey)));
        }
      }
    }

    const changesParsed = parseJsonColumn(row.external_dependency_changes, workflowId, 'external_dependency_changes', problems);
    if (changesParsed.ok && changesParsed.value !== undefined) {
      if (!Array.isArray(changesParsed.value)) {
        addProblem(problems, workflowId, 'invalid_dependency_entries', 'external_dependency_changes', 'external_dependency_changes must be an array when present');
      } else {
        const validationErrors = [];
        changesParsed.value.forEach((change, index) => validateDependencyChange(change, `external_dependency_changes[${index}]`, validationErrors));
        if (validationErrors.length > 0) {
          addProblem(problems, workflowId, 'invalid_dependency_entries', 'external_dependency_changes', validationErrors.join('; '));
        }
      }
    }
  }
  return dependencyKeysByWorkflow;
}

function scanLegacyTaskDependencyEvidence(db, workflowDependencyKeys, problems) {
  if (!hasTable(db, 'tasks')) return;
  const taskColumns = tableColumns(db, 'tasks');
  if (!taskColumns.has('workflow_id') || !taskColumns.has('external_dependencies')) return;
  const rows = db.prepare(
    `SELECT id, workflow_id, external_dependencies
       FROM tasks
      WHERE external_dependencies IS NOT NULL AND external_dependencies != ''
      ORDER BY workflow_id, id`,
  ).all();
  const affected = new Map();
  for (const row of rows) {
    const workflowId = String(row.workflow_id ?? '');
    let parsed;
    try {
      parsed = JSON.parse(String(row.external_dependencies));
    } catch {
      if (!affected.has(workflowId)) affected.set(workflowId, { taskIds: [], messages: [] });
      affected.get(workflowId).messages.push(`task ${String(row.id)} has malformed legacy external_dependencies`);
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    const validationErrors = [];
    parsed.forEach((dep, index) => validateDependency(dep, `task ${String(row.id)} external_dependencies[${index}]`, validationErrors));
    if (!affected.has(workflowId)) affected.set(workflowId, { taskIds: [], messages: [] });
    affected.get(workflowId).taskIds.push(String(row.id));
    if (validationErrors.length > 0) {
      affected.get(workflowId).messages.push(...validationErrors);
      continue;
    }
    const workflowKeys = workflowDependencyKeys.get(workflowId) ?? new Set();
    const missing = parsed.filter((dep) => !workflowKeys.has(dependencyKey(dep)));
    if (missing.length > 0) {
      affected.get(workflowId).messages.push(`task ${String(row.id)} has dependency evidence not present on workflow metadata`);
    }
  }
  for (const [workflowId, info] of affected) {
    const messages = info.messages.length > 0 ? info.messages : ['legacy task-level external dependency evidence remains'];
    problems.push({
      workflowId,
      type: 'ambiguous_dependency_loss',
      column: 'tasks.external_dependencies',
      taskIds: [...new Set(info.taskIds)],
      message: messages.join('; '),
      repairable: false,
      repaired: false,
    });
  }
}

function summarize(problems, repairs) {
  const remaining = problems.filter((problem) => !problem.repaired);
  return { clean: remaining.length === 0, problems, repairs, remaining };
}

function printText(result, opts) {
  if (result.clean) {
    if (result.repairs.length > 0) {
      console.log(`Workflow consistency check repaired ${result.repairs.length} problem(s) in ${opts.db}.`);
      for (const repair of result.repairs) console.log(`- ${repair.workflowId}: ${repair.action}`);
    } else {
      console.log(`Workflow consistency check clean: ${opts.db}`);
    }
    return;
  }
  console.error(`Workflow consistency check found ${result.remaining.length} unrepaired problem(s) in ${opts.db}:`);
  for (const problem of result.remaining) {
    const suffix = problem.taskIds?.length ? ` tasks=${problem.taskIds.join(',')}` : '';
    const repair = problem.repairable ? ' (run with --repair to fix safely)' : '';
    console.error(`- ${problem.workflowId}: ${problem.type} ${problem.column}: ${problem.message}${suffix}${repair}`);
  }
  if (result.repairs.length > 0) {
    console.error(`Repaired ${result.repairs.length} safe problem(s).`);
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(usage());
      process.exit(0);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.stderr.write(usage());
    process.exit(2);
  }

  const problems = [];
  const repairs = [];
  if (!existsSync(opts.db)) {
    addProblem(problems, '*', 'missing_database', 'database', `database does not exist: ${opts.db}`);
    const result = summarize(problems, repairs);
    if (opts.json) console.log(JSON.stringify({ db: opts.db, repair: opts.repair, ...result }, null, 2));
    else printText(result, opts);
    process.exit(1);
  }

  let db;
  try {
    db = new DatabaseSync(opts.db, { readOnly: !opts.repair });
    if (!hasTable(db, 'workflows')) {
      addProblem(problems, '*', 'missing_workflows_table', 'workflows', 'workflows table is missing');
    } else {
      const columns = tableColumns(db, 'workflows');
      const workflowDependencyKeys = validateWorkflowRows(db, columns, opts, problems, repairs);
      scanLegacyTaskDependencyEvidence(db, workflowDependencyKeys, problems);
    }
  } finally {
    db?.close();
  }

  const result = summarize(problems, repairs);
  if (opts.json) console.log(JSON.stringify({ db: opts.db, repair: opts.repair, ...result }, null, 2));
  else printText(result, opts);
  process.exit(result.clean ? 0 : 1);
}

main();
