export const WORKER_DESIRED_STATE_TABLE = 'worker_desired_state';

export const WORKER_DESIRED_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS worker_desired_state (
    worker_kind TEXT PRIMARY KEY,
    desired_state TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`;
