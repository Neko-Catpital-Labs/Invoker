#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertWorkflowConsistent } from '../packages/workflow-core/src/state-invariants.ts';

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

function dependencyKey(dep) {
  return `${dep.workflowId}\u0000${dep.taskId ?? ''}`;
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

function addWorkflowInvariantProblem(db, columns, opts, repairs, problems, workflowId, message) {
  if (/\bgeneration\b/.test(message)) {
    addProblem(problems, workflowId, 'invalid_generation', 'generation', message, true);
    if (opts.repair && columns.has('generation')) {
      db.prepare('UPDATE workflows SET generation = 0 WHERE id = ?').run(workflowId);
      repairs.push({ workflowId, type: 'invalid_generation', column: 'generation', action: 'set generation to 0' });
      problems[problems.length - 1].repaired = true;
    }
    return;
  }

  if (/externalDependencies must be non-empty/.test(message)) {
    addProblem(problems, workflowId, 'empty_external_dependencies', 'external_dependencies', message, true);
    if (opts.repair && columns.has('external_dependencies')) {
      db.prepare('UPDATE workflows SET external_dependencies = NULL WHERE id = ?').run(workflowId);
      repairs.push({ workflowId, type: 'empty_external_dependencies', column: 'external_dependencies', action: 'normalized [] to NULL' });
      problems[problems.length - 1].repaired = true;
    }
    return;
  }

  if (/external_dependency_changes|externalDependencyChanges/.test(message)) {
    addProblem(problems, workflowId, 'invalid_dependency_entries', 'external_dependency_changes', message);
    return;
  }

  if (/external_dependencies|externalDependencies|workflowId|taskId|requiredStatus|gatePolicy/.test(message)) {
    addProblem(problems, workflowId, 'invalid_dependency_entries', 'external_dependencies', message);
    return;
  }

  addProblem(problems, workflowId, 'invalid_workflow_state', 'workflows', message);
}

function workflowInvariantMessage(workflow) {
  try {
    assertWorkflowConsistent(workflow);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function dependencyListIsConsistent(workflowId, deps) {
  return workflowInvariantMessage({
    id: workflowId || 'workflow',
    name: workflowId || 'workflow',
    generation: 0,
    externalDependencies: deps,
  }) === undefined;
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
    const depsParsed = parseJsonColumn(row.external_dependencies, workflowId, 'external_dependencies', problems);
    const changesParsed = parseJsonColumn(row.external_dependency_changes, workflowId, 'external_dependency_changes', problems);
    const workflow = {
      id: workflowId,
      name: row.name,
      generation: row.generation,
      ...(depsParsed.ok && depsParsed.value !== undefined ? { externalDependencies: depsParsed.value } : {}),
      ...(changesParsed.ok && changesParsed.value !== undefined ? { externalDependencyChanges: changesParsed.value } : {}),
    };

    const message = workflowInvariantMessage(workflow);
    if (message) {
      addWorkflowInvariantProblem(db, columns, opts, repairs, problems, workflowId, message);
    }

    if (
      depsParsed.ok
      && Array.isArray(depsParsed.value)
      && depsParsed.value.length > 0
      && dependencyListIsConsistent(workflowId, depsParsed.value)
    ) {
      dependencyKeysByWorkflow.set(workflowId, new Set(depsParsed.value.map(dependencyKey)));
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
    const dependencyMessage = dependencyListIsConsistent(workflowId, parsed)
      ? undefined
      : workflowInvariantMessage({
        id: workflowId || 'workflow',
        name: workflowId || 'workflow',
        generation: 0,
        externalDependencies: parsed,
      });
    if (!affected.has(workflowId)) affected.set(workflowId, { taskIds: [], messages: [] });
    affected.get(workflowId).taskIds.push(String(row.id));
    if (dependencyMessage) {
      affected.get(workflowId).messages.push(`task ${String(row.id)} ${dependencyMessage}`);
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
