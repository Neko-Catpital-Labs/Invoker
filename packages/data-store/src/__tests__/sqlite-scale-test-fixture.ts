import type { DatabaseSync } from 'node:sqlite';
import type { SQLiteAdapter } from '../sqlite-adapter.js';

interface WorkflowScaleFixtureOptions {
  includeTasks?: boolean;
  longMetadata?: boolean;
}

function nativeDatabase(adapter: SQLiteAdapter): DatabaseSync {
  return (adapter as unknown as { nativeDb: DatabaseSync }).nativeDb;
}

function runFixtureTransaction(db: DatabaseSync, seed: () => void): void {
  db.exec('BEGIN');
  try {
    seed();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function seedWorkflowScaleFixture(
  adapter: SQLiteAdapter,
  workflowCount: number,
  options: WorkflowScaleFixtureOptions = {},
): void {
  const db = nativeDatabase(adapter);
  const insertWorkflow = db.prepare(`
    INSERT INTO workflows (id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertTask = options.includeTasks
    ? db.prepare(`
        INSERT INTO tasks (
          id, workflow_id, description, status, dependencies, created_at, task_state_version
        ) VALUES (?, ?, ?, 'pending', '[]', ?, 1)
      `)
    : null;
  const timestamp = new Date().toISOString();

  runFixtureTransaction(db, () => {
    for (let i = 0; i < workflowCount; i += 1) {
      const workflowId = `wf-${i}`;
      const name = options.longMetadata
        ? `Workflow ${i} with a longer name to increase memory footprint`
        : `Workflow ${i}`;
      const description = options.longMetadata
        ? `Description for workflow ${i} that adds more bytes per row`
        : null;
      insertWorkflow.run(workflowId, name, description, timestamp, timestamp);
      insertTask?.run(`${workflowId}/t0`, workflowId, `Task ${i}`, timestamp);
    }
  });
}
