import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';

// Intentionally frozen pre-surface DDL: exercise a real upgrade, not a fresh DB
// whose columns already match the implementation under test.
const legacyTables = {
  conversations: `CREATE TABLE conversations (
    thread_ts TEXT PRIMARY KEY, channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
    mode TEXT DEFAULT 'plan', extracted_plan TEXT, plan_submitted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`,
  slack_launch_contexts: `CREATE TABLE slack_launch_contexts (
    thread_ts TEXT PRIMARY KEY, repo_url TEXT NOT NULL, harness_preset TEXT NOT NULL,
    working_dir TEXT NOT NULL, requested_by TEXT NOT NULL, lobby_channel_id TEXT NOT NULL,
    confirmation_mode TEXT NOT NULL DEFAULT 'require', harness_session_id TEXT
  )`,
  slack_plan_drafts: `CREATE TABLE slack_plan_drafts (
    draft_id TEXT NOT NULL, version INTEGER NOT NULL, planning_draft_id TEXT,
    channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, message_ts TEXT, slack_file_id TEXT,
    plan_text TEXT NOT NULL, content_hash TEXT NOT NULL, summary_json TEXT NOT NULL,
    status TEXT NOT NULL, repo_url TEXT NOT NULL, harness_preset TEXT NOT NULL,
    working_dir TEXT NOT NULL, requested_by TEXT NOT NULL,
    confirmation_mode TEXT NOT NULL DEFAULT 'require', created_at TEXT NOT NULL,
    decided_at TEXT, decided_by TEXT, execution_key TEXT, workflow_ids_json TEXT,
    PRIMARY KEY (draft_id, version)
  )`,
  slack_pending_confirmations: `CREATE TABLE slack_pending_confirmations (
    confirm_key TEXT PRIMARY KEY, thread_ts TEXT NOT NULL, channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`,
};

describe('surface persistence', () => {
  it('upgrades populated legacy tables additively and survives a second startup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'surface-migration-'));
    const path = join(directory, 'legacy.db');
    try {
      const legacy = new DatabaseSync(path);
      const snapshots = new Map<string, { columns: string[]; rows: unknown[] }>();
      try {
        for (const [table, ddl] of Object.entries(legacyTables)) {
          legacy.exec(ddl);
          const columns = legacy.prepare(`PRAGMA table_info(${table})`).all();
          const names = columns.map(column => String(column.name));
          const values = columns.map(column => column.type === 'INTEGER' ? 1 : 'legacy');
          legacy.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...values);
          snapshots.set(table, { columns: names, rows: legacy.prepare(`SELECT * FROM ${table}`).all() });
        }
      } finally {
        legacy.close();
      }

      for (let startup = 0; startup < 2; startup++) {
        const adapter = await SQLiteAdapter.create(path, { ownerCapability: true });
        adapter.close();
        const reader = new DatabaseSync(path, { readOnly: true });
        try {
          for (const [table, before] of snapshots) {
            const columns = reader.prepare(`PRAGMA table_info(${table})`).all();
            expect(columns.map(column => column.name)).toEqual([...before.columns, 'surface']);
            expect(columns.find(column => column.name === 'surface')).toMatchObject({
              type: 'TEXT', notnull: 1, dflt_value: "'slack'",
            });
            expect(reader.prepare(`SELECT ${before.columns.join(', ')} FROM ${table}`).all()).toEqual(before.rows);
            expect(reader.prepare(`SELECT surface FROM ${table}`).all()).toEqual([{ surface: 'slack' }]);
            expect(reader.prepare(`PRAGMA index_info(idx_${table}_surface_thread)`).all().map(column => column.name))
              .toEqual(['surface', 'thread_ts']);
          }
        } finally {
          reader.close();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
