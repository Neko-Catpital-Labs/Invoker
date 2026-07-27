import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation } from '../adapter.js';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { SlackSessionRepository } from '../slack-session-repository.js';

describe('SlackSessionRepository', () => {
  let adapter: SQLiteAdapter;
  let repo: SlackSessionRepository;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new SlackSessionRepository(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  it('round-trips per-thread launch context', () => {
    const context = {
      threadTs: 'thread-1',
      repoUrl: 'https://github.com/acme/repo.git',
      harnessPreset: 'claude',
      workingDir: '/tmp/repo',
      requestedBy: 'U123',
      lobbyChannelId: 'C456',
      confirmationMode: 'require' as const,
    };

    repo.saveLaunchContext(context);

    expect(repo.getLaunchContext(context.threadTs)).toEqual(context);
    repo.deleteLaunchContext(context.threadTs);
    expect(repo.getLaunchContext(context.threadTs)).toBeNull();
  });

  it('restores launch context after an adapter restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'slack-session-repository-'));
    const databasePath = join(directory, 'invoker.db');
    const context = {
      threadTs: 'thread-restart',
      repoUrl: 'https://github.com/acme/repo.git',
      harnessPreset: 'claude',
      workingDir: '/tmp/repo',
      requestedBy: 'U123',
      lobbyChannelId: 'C456',
      confirmationMode: 'require' as const,
    };
    try {
      const writer = await SQLiteAdapter.create(databasePath, { ownerCapability: true });
      new SlackSessionRepository(writer).saveLaunchContext(context);
      writer.close();

      const restarted = await SQLiteAdapter.create(databasePath, { ownerCapability: true });
      expect(new SlackSessionRepository(restarted).getLaunchContext(context.threadTs)).toEqual(context);
      restarted.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists confirmations with a JSON payload and no expiration', () => {
    const createdAt = new Date('2026-07-19T12:00:00.000Z');
    const confirmation = repo.createPendingConfirmation({
      confirmKey: 'confirm-1',
      threadTs: 'thread-1',
      channelId: 'C1',
      userId: 'U1',
      kind: 'plan_submission',
      payload: { workflowId: 'wf-1', approved: true },
    }, createdAt);

    expect(confirmation.createdAt).toBe(createdAt.toISOString());
    // The expires_at column is kept populated for schema compatibility but
    // has no read semantics.
    expect(confirmation.expiresAt).toBe(createdAt.toISOString());
    expect(repo.getPendingConfirmation('confirm-1')).toEqual(confirmation);

    repo.deletePendingConfirmation('confirm-1');
    expect(repo.getPendingConfirmation('confirm-1')).toBeNull();
  });

  it('returns confirmations staged more than 24 hours ago', () => {
    const createdAt = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const confirmation = repo.createPendingConfirmation({
      confirmKey: 'old-confirmation',
      threadTs: 'thread-1',
      channelId: 'C1',
      userId: 'U1',
      kind: 'plan_submission',
      payload: { workflowId: 'wf-1' },
    }, createdAt);

    expect(repo.getPendingConfirmation('old-confirmation')).toEqual(confirmation);
  });

  it('returns the newest confirmation for a thread', () => {
    const base = new Date('2026-07-19T12:00:00.000Z');
    repo.createPendingConfirmation({
      confirmKey: 'thread-2:older',
      threadTs: 'thread-2',
      channelId: 'C1',
      userId: 'U1',
      kind: 'submit',
      payload: { plan: 'older' },
    }, base);
    const newest = repo.createPendingConfirmation({
      confirmKey: 'thread-2:newer',
      threadTs: 'thread-2',
      channelId: 'C1',
      userId: 'U1',
      kind: 'submit',
      payload: { plan: 'newer' },
    }, new Date(base.getTime() + 60_000));

    expect(repo.getLatestPendingConfirmationForThread('thread-2')).toEqual(newest);
    expect(repo.getLatestPendingConfirmationForThread('missing-thread')).toBeNull();
  });

  it('loads pending confirmations from a read-only adapter', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'slack-session-repository-'));
    const databasePath = join(directory, 'invoker.db');
    const createdAt = new Date('2026-07-19T12:00:00.000Z');
    try {
      const writer = await SQLiteAdapter.create(databasePath, { ownerCapability: true });
      const confirmation = new SlackSessionRepository(writer).createPendingConfirmation({
        confirmKey: 'read-only-confirmation',
        threadTs: 'thread-read-only',
        channelId: 'C1',
        userId: 'U1',
        kind: 'plan_submission',
        payload: { workflowId: 'wf-1' },
      }, createdAt);
      writer.close();

      const reader = await SQLiteAdapter.create(databasePath, { readOnly: true });
      expect(
        new SlackSessionRepository(reader).getPendingConfirmation('read-only-confirmation'),
      ).toEqual(confirmation);
      reader.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns only active plan threads for the channel and user', () => {
    const now = new Date().toISOString();
    const conversations: Conversation[] = [
      {
        threadTs: 'active-plan',
        channelId: 'C1',
        userId: 'U1',
        mode: 'plan',
        extractedPlan: null,
        planSubmitted: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        threadTs: 'submitted-plan',
        channelId: 'C1',
        userId: 'U1',
        mode: 'plan',
        extractedPlan: null,
        planSubmitted: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        threadTs: 'agent-thread',
        channelId: 'C1',
        userId: 'U1',
        mode: 'agent',
        extractedPlan: null,
        planSubmitted: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        threadTs: 'other-user',
        channelId: 'C1',
        userId: 'U2',
        mode: 'plan',
        extractedPlan: null,
        planSubmitted: false,
        createdAt: now,
        updatedAt: now,
      },
    ];
    for (const conversation of conversations) {
      adapter.saveConversation(conversation);
    }

    expect(repo.listActivePlanThreads('C1', 'U1').map((thread) => thread.threadTs)).toEqual([
      'active-plan',
    ]);
  });
});
