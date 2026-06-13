#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
DB="$TMP_DIR/invoker.db"

cd "$ROOT_DIR"

node --input-type=module - "$DB" <<'NODE'
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    external_dependencies TEXT CHECK (external_dependencies IS NULL OR json_valid(external_dependencies)),
    external_dependency_changes TEXT CHECK (external_dependency_changes IS NULL OR json_valid(external_dependency_changes)),
    generation INTEGER DEFAULT 0 CHECK (typeof(generation) = 'integer' AND generation >= 0),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    external_dependencies TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id)
  );
`);
db.exec('PRAGMA ignore_check_constraints = ON');
const insertWorkflow = db.prepare(`
  INSERT INTO workflows (id, name, external_dependencies, external_dependency_changes, generation)
  VALUES (?, ?, ?, ?, ?)
`);
insertWorkflow.run(
  'wf-clean',
  'Clean workflow',
  JSON.stringify([{ workflowId: 'wf-upstream', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' }]),
  null,
  2,
);
insertWorkflow.run('wf-empty-deps', 'Empty deps', JSON.stringify([]), null, 4);
insertWorkflow.run('wf-null-generation', 'Null generation', null, null, null);
insertWorkflow.run(
  'wf-bad-entry',
  'Bad dependency entry',
  JSON.stringify([{ workflowId: '', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' }]),
  null,
  0,
);
insertWorkflow.run('wf-loss-evidence', 'Loss evidence', null, null, 0);
db.prepare(`
  INSERT INTO tasks (id, workflow_id, external_dependencies) VALUES (?, ?, ?)
`).run(
  'wf-loss-evidence/root',
  'wf-loss-evidence',
  JSON.stringify([{ workflowId: 'wf-vanished', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' }]),
);
db.exec('PRAGMA ignore_check_constraints = OFF');
db.close();
NODE

set +e
node scripts/check-workflow-consistency.mjs --db "$DB" --json > "$TMP_DIR/check-before.json" 2> "$TMP_DIR/check-before.err"
BEFORE_STATUS=$?
set -e
if [[ "$BEFORE_STATUS" -eq 0 ]]; then
  echo "expected checker without --repair to fail" >&2
  exit 1
fi
node --input-type=module - "$TMP_DIR/check-before.json" <<'NODE'
import { readFileSync } from 'node:fs';
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const types = new Set(result.remaining.map((problem) => problem.type));
for (const type of ['empty_external_dependencies', 'invalid_generation', 'invalid_dependency_entries', 'ambiguous_dependency_loss']) {
  if (!types.has(type)) throw new Error(`missing problem type before repair: ${type}`);
}
NODE

set +e
node scripts/check-workflow-consistency.mjs --db "$DB" --repair --json > "$TMP_DIR/check-repair.json" 2> "$TMP_DIR/check-repair.err"
REPAIR_STATUS=$?
set -e
if [[ "$REPAIR_STATUS" -eq 0 ]]; then
  echo "expected checker with --repair to keep ambiguous/bad rows non-zero" >&2
  exit 1
fi
node --input-type=module - "$TMP_DIR/check-repair.json" "$DB" <<'NODE'
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!result.repairs.some((repair) => repair.workflowId === 'wf-empty-deps' && repair.action === 'normalized [] to NULL')) {
  throw new Error('empty dependency array repair was not reported');
}
if (!result.repairs.some((repair) => repair.workflowId === 'wf-null-generation' && repair.action === 'set generation to 0')) {
  throw new Error('generation repair was not reported');
}
const remaining = new Set(result.remaining.map((problem) => `${problem.workflowId}:${problem.type}`));
if (!remaining.has('wf-bad-entry:invalid_dependency_entries')) throw new Error('bad dependency entry should remain');
if (!remaining.has('wf-loss-evidence:ambiguous_dependency_loss')) throw new Error('ambiguous dependency loss should remain');
const db = new DatabaseSync(process.argv[3], { readOnly: true });
const repaired = db.prepare(`
  SELECT id, external_dependencies, generation
    FROM workflows
   WHERE id IN ('wf-empty-deps', 'wf-null-generation')
   ORDER BY id
`).all();
db.close();
const byId = new Map(repaired.map((row) => [row.id, row]));
if (byId.get('wf-empty-deps').external_dependencies !== null) throw new Error('empty dependencies were not normalized to NULL');
if (byId.get('wf-null-generation').generation !== 0) throw new Error('invalid generation was not set to 0');
NODE

node --input-type=module - "$DB" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.prepare(`DELETE FROM tasks WHERE workflow_id = ?`).run('wf-loss-evidence');
db.prepare(`DELETE FROM workflows WHERE id = ?`).run('wf-bad-entry');
db.close();
NODE

node scripts/check-workflow-consistency.mjs --db "$DB" --json > "$TMP_DIR/check-clean.json"
node --input-type=module - "$TMP_DIR/check-clean.json" <<'NODE'
import { readFileSync } from 'node:fs';
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (result.clean !== true || result.remaining.length !== 0) throw new Error('expected clean result after removing unrepaired rows');
NODE

echo "workflow consistency script proof passed"
