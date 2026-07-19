import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation } from '../adapter.js';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import {
  SLACK_PENDING_CONFIRMATION_TTL_MS,
  SlackSessionRepository,
} from '../slack-session-repository.js';

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

  it('persists confirmations with a 24-hour expiration and JSON payload', () => {
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
    expect(confirmation.expiresAt).toBe(
      new Date(createdAt.getTime() + SLACK_PENDING_CONFIRMATION_TTL_MS).toISOString(),
    );
    expect(repo.getPendingConfirmation('confirm-1', createdAt)).toEqual(confirmation);

    repo.deletePendingConfirmation('confirm-1');
    expect(repo.getPendingConfirmation('confirm-1', createdAt)).toBeNull();
  });

  it('purges expired confirmations before retrieving them', () => {
    const createdAt = new Date('2026-07-19T12:00:00.000Z');
    repo.createPendingConfirmation({
      confirmKey: 'expired-confirmation',
      threadTs: 'thread-1',
      channelId: 'C1',
      userId: 'U1',
      kind: 'plan_submission',
      payload: { workflowId: 'wf-1' },
    }, createdAt);

    const afterExpiry = new Date(createdAt.getTime() + SLACK_PENDING_CONFIRMATION_TTL_MS);
    expect(repo.getPendingConfirmation('expired-confirmation', afterExpiry)).toBeNull();
    expect(repo.purgeExpiredPendingConfirmations(afterExpiry)).toBe(0);
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
