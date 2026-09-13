import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationRepository } from '../conversation-repository.js';
import { SlackPlanDraftRepository, type CreateSlackPlanDraft } from '../slack-plan-draft-repository.js';
import { SlackSessionRepository } from '../slack-session-repository.js';
import { SQLiteAdapter } from '../sqlite-adapter.js';

const SURFACE_TABLES = [
  'conversations',
  'slack_launch_contexts',
  'slack_plan_drafts',
  'slack_pending_confirmations',
] as const;

const PRE_SURFACE_DDL = `
  CREATE TABLE conversations (
    thread_ts TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    mode TEXT DEFAULT 'plan',
    extracted_plan TEXT,
    plan_submitted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE slack_launch_contexts (
    thread_ts TEXT PRIMARY KEY,
    repo_url TEXT NOT NULL,
    harness_preset TEXT NOT NULL,
    working_dir TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    lobby_channel_id TEXT NOT NULL,
    confirmation_mode TEXT NOT NULL DEFAULT 'require',
    harness_session_id TEXT
  );
  CREATE TABLE slack_plan_drafts (
    draft_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    planning_draft_id TEXT,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    message_ts TEXT,
    slack_file_id TEXT,
    plan_text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    status TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    harness_preset TEXT NOT NULL,
    working_dir TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    confirmation_mode TEXT NOT NULL DEFAULT 'require',
    created_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    execution_key TEXT,
    workflow_ids_json TEXT,
    PRIMARY KEY (draft_id, version)
  );
  CREATE TABLE slack_pending_confirmations (
    confirm_key TEXT PRIMARY KEY,
    thread_ts TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  INSERT INTO conversations (thread_ts, channel_id, user_id, mode, extracted_plan, plan_submitted, created_at, updated_at)
    VALUES ('legacy-thread', 'C1', 'U1', 'plan', NULL, 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
  INSERT INTO slack_launch_contexts (thread_ts, repo_url, harness_preset, working_dir, requested_by, lobby_channel_id, confirmation_mode)
    VALUES ('legacy-thread', 'https://github.com/acme/repo.git', 'claude', '/tmp/repo', 'U1', 'C1', 'require');
  INSERT INTO slack_plan_drafts (draft_id, version, channel_id, thread_ts, message_ts, slack_file_id, plan_text, content_hash,
      summary_json, status, repo_url, harness_preset, working_dir, requested_by, confirmation_mode, created_at)
    VALUES ('legacy-draft', 1, 'C1', 'legacy-thread', '1.2', 'F1', 'name: legacy', 'hash', '{}', 'ready',
      'https://github.com/acme/repo.git', 'claude', '/tmp/repo', 'U1', 'require', '2026-09-01T00:00:00.000Z');
  INSERT INTO slack_pending_confirmations (confirm_key, thread_ts, channel_id, user_id, kind, payload_json, created_at, expires_at)
    VALUES ('legacy-confirm', 'legacy-thread', 'C1', 'U1', 'plan_submission', '{"ok":true}', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
`;

function draftInput(threadTs: string, surface?: string): CreateSlackPlanDraft {
  return {
    channelId: 'C1',
    threadTs,
    planText: `name: ${surface ?? 'default'}\ntasks:\n  - id: task\n    description: Test`,
    summaryJson: '{}',
    repoUrl: 'https://github.com/acme/repo.git',
    harnessPreset: 'codex',
    workingDir: '/tmp/repo',
    requestedBy: 'U1',
    confirmationMode: 'require',
    ...(surface ? { surface } : {}),
  };
}

function launchContext(threadTs: string, surface?: string) {
  return {
    threadTs,
    repoUrl: 'https://github.com/acme/repo.git',
    harnessPreset: 'claude',
    workingDir: '/tmp/repo',
    requestedBy: 'U1',
    lobbyChannelId: 'C1',
    confirmationMode: 'require' as const,
    ...(surface ? { surface } : {}),
  };
}

describe('surface discriminator: upgrade of a pre-surface database', () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'surface-discriminator-'));
    databasePath = join(directory, 'legacy.db');
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(PRE_SURFACE_DDL);
    } finally {
      legacy.close();
    }
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function snapshotLegacyColumns(): Map<string, { columns: string[]; rows: unknown[] }> {
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return new Map(SURFACE_TABLES.map((table) => {
        const columns = reader.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name));
        return [table, { columns, rows: reader.prepare(`SELECT * FROM ${table}`).all() }];
      }));
    } finally {
      reader.close();
    }
  }

  it('reads pre-existing rows with no surface value back as slack through every repository', async () => {
    const adapter = await SQLiteAdapter.create(databasePath, { ownerCapability: true });
    try {
      expect(new ConversationRepository(adapter).loadConversation('legacy-thread')?.surface).toBe('slack');
      const sessions = new SlackSessionRepository(adapter);
      expect(sessions.getLaunchContext('legacy-thread')?.surface).toBe('slack');
      expect(sessions.getPendingConfirmation('legacy-confirm')?.surface).toBe('slack');
      expect(sessions.getLatestPendingConfirmationForThread('legacy-thread', 'slack')?.confirmKey).toBe('legacy-confirm');
      const drafts = new SlackPlanDraftRepository(adapter);
      expect(drafts.get('legacy-draft', 1)?.surface).toBe('slack');
      expect(drafts.getReady('C1', 'legacy-thread', 'slack')?.draftId).toBe('legacy-draft');
    } finally {
      adapter.close();
    }
  });

  it('adds only the surface column and its index, leaving every legacy value untouched across restarts', async () => {
    const before = snapshotLegacyColumns();

    for (let startup = 0; startup < 2; startup++) {
      const adapter = await SQLiteAdapter.create(databasePath, { ownerCapability: true });
      adapter.close();

      const reader = new DatabaseSync(databasePath, { readOnly: true });
      try {
        for (const table of SURFACE_TABLES) {
          const legacy = before.get(table)!;
          const columns = reader.prepare(`PRAGMA table_info(${table})`).all();
          expect(columns.map((column) => column.name)).toEqual([...legacy.columns, 'surface']);
          expect(columns.find((column) => column.name === 'surface')).toMatchObject({
            type: 'TEXT',
            notnull: 1,
            dflt_value: "'slack'",
          });
          expect(reader.prepare(`SELECT ${legacy.columns.join(', ')} FROM ${table}`).all()).toEqual(legacy.rows);
          expect(reader.prepare(`SELECT surface FROM ${table}`).all()).toEqual([{ surface: 'slack' }]);
          expect(
            reader.prepare(`PRAGMA index_info(idx_${table}_surface_thread)`).all().map((column) => column.name),
          ).toEqual(['surface', 'thread_ts']);
        }
      } finally {
        reader.close();
      }
    }
  });
});

describe('surface discriminator: two surfaces sharing one thread id', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => adapter.close());

  it('defaults every write to slack when no surface is passed', () => {
    new ConversationRepository(adapter).saveConversation('T1', [{ role: 'user', content: 'hi' }], null, false, 'C1', 'U1');
    const sessions = new SlackSessionRepository(adapter);
    sessions.saveLaunchContext(launchContext('T1'));
    sessions.createPendingConfirmation({
      confirmKey: 'K1', threadTs: 'T1', channelId: 'C1', userId: 'U1', kind: 'plan_submission', payload: {},
    });
    const draft = new SlackPlanDraftRepository(adapter).create(draftInput('T1'));

    expect(adapter.loadConversation('T1')?.surface).toBe('slack');
    expect(adapter.loadSlackLaunchContext('T1')?.surface).toBe('slack');
    expect(adapter.loadSlackPendingConfirmation('K1')?.surface).toBe('slack');
    expect(adapter.loadSlackPlanDraft(draft.draftId, draft.version)?.surface).toBe('slack');
  });

  it('keeps plan drafts for the same channel and thread separate per surface', () => {
    const repository = new SlackPlanDraftRepository(adapter);
    const makeReady = (surface: string) => {
      const draft = repository.create(draftInput('shared-thread', surface));
      repository.bindMessage(draft, `${surface}.msg`);
      repository.bindAttachment(draft, `${surface}-file`);
      repository.markReady(draft);
      return draft;
    };

    const slackDraft = makeReady('slack');
    const discordDraft = makeReady('discord');

    expect(repository.getReady('C1', 'shared-thread', 'slack')).toMatchObject({
      draftId: slackDraft.draftId,
      surface: 'slack',
      status: 'ready',
      version: 1,
    });
    expect(repository.getReady('C1', 'shared-thread', 'discord')).toMatchObject({
      draftId: discordDraft.draftId,
      surface: 'discord',
      status: 'ready',
      version: 1,
    });
  });

  it('keeps pending confirmations for the same thread separate per surface', () => {
    const sessions = new SlackSessionRepository(adapter);
    sessions.createPendingConfirmation({
      confirmKey: 'slack-key', threadTs: 'shared-thread', channelId: 'C1', userId: 'U1', kind: 'plan_submission', payload: { from: 'slack' },
    }, new Date('2026-09-01T00:00:00.000Z'));
    sessions.createPendingConfirmation({
      confirmKey: 'discord-key', threadTs: 'shared-thread', channelId: 'C1', userId: 'U1', kind: 'plan_submission', payload: { from: 'discord' }, surface: 'discord',
    }, new Date('2026-09-02T00:00:00.000Z'));

    expect(sessions.getLatestPendingConfirmationForThread('shared-thread', 'slack')).toMatchObject({
      confirmKey: 'slack-key', surface: 'slack', payload: { from: 'slack' },
    });
    expect(sessions.getLatestPendingConfirmationForThread('shared-thread', 'discord')).toMatchObject({
      confirmKey: 'discord-key', surface: 'discord', payload: { from: 'discord' },
    });
    expect(sessions.getPendingConfirmation('slack-key', 'discord')).toBeNull();
    expect(sessions.getPendingConfirmation('discord-key', 'slack')).toBeNull();
  });

  it('refuses to overwrite a slack conversation from another surface and leaves the slack row intact', () => {
    const repository = new ConversationRepository(adapter);
    repository.saveConversation('shared-thread', [{ role: 'user', content: 'from slack' }], null, false, 'C1', 'U1');

    expect(() => repository.saveConversation(
      'shared-thread', [{ role: 'user', content: 'from discord' }], null, false, 'D1', 'U2', 'plan', 'discord',
    )).toThrow(/belongs to surface 'slack'/);

    expect(repository.loadConversation('shared-thread', 'discord')).toBeNull();
    expect(repository.loadConversation('shared-thread', 'slack')).toMatchObject({
      channelId: 'C1',
      userId: 'U1',
      surface: 'slack',
      messages: [{ role: 'user', content: 'from slack' }],
    });
  });

  it('refuses to overwrite a slack launch context from another surface and leaves the slack row intact', () => {
    const sessions = new SlackSessionRepository(adapter);
    sessions.saveLaunchContext(launchContext('shared-thread'));

    expect(() => sessions.saveLaunchContext({ ...launchContext('shared-thread', 'discord'), workingDir: '/tmp/discord' }))
      .toThrow(/belongs to surface 'slack'/);

    expect(sessions.getLaunchContext('shared-thread', 'discord')).toBeNull();
    expect(sessions.getLaunchContext('shared-thread', 'slack')).toMatchObject({ workingDir: '/tmp/repo', surface: 'slack' });

    sessions.deleteLaunchContext('shared-thread', 'discord');
    expect(sessions.getLaunchContext('shared-thread', 'slack')).not.toBeNull();
  });

  it('refuses to reuse a slack confirmation key from another surface', () => {
    const sessions = new SlackSessionRepository(adapter);
    sessions.createPendingConfirmation({
      confirmKey: 'K1', threadTs: 'T1', channelId: 'C1', userId: 'U1', kind: 'plan_submission', payload: { from: 'slack' },
    });

    expect(() => sessions.createPendingConfirmation({
      confirmKey: 'K1', threadTs: 'T1', channelId: 'C1', userId: 'U1', kind: 'plan_submission', payload: { from: 'discord' }, surface: 'discord',
    })).toThrow(/belongs to surface 'slack'/);
    expect(sessions.getPendingConfirmation('K1')).toMatchObject({ surface: 'slack', payload: { from: 'slack' } });
  });

  it('returns every surface when a read omits the surface filter', () => {
    const sessions = new SlackSessionRepository(adapter);
    sessions.createPendingConfirmation({
      confirmKey: 'slack-key', threadTs: 'shared-thread', channelId: 'C1', userId: 'U1', kind: 'plan_submission', payload: {},
    }, new Date('2026-09-01T00:00:00.000Z'));
    sessions.createPendingConfirmation({
      confirmKey: 'discord-key', threadTs: 'shared-thread', channelId: 'C1', userId: 'U1', kind: 'plan_submission', payload: {}, surface: 'discord',
    }, new Date('2026-09-02T00:00:00.000Z'));

    expect(sessions.getLatestPendingConfirmationForThread('shared-thread')?.confirmKey).toBe('discord-key');
    expect(sessions.getPendingConfirmation('slack-key')?.surface).toBe('slack');
    expect(sessions.getPendingConfirmation('discord-key')?.surface).toBe('discord');
  });
});
