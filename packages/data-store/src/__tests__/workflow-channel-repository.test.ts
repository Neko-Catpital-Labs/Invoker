import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { WorkflowChannelRepository } from '../workflow-channel-repository.js';
import type { WorkflowChannel } from '../adapter.js';

describe('WorkflowChannelRepository', () => {
  let adapter: SQLiteAdapter;
  let repo: WorkflowChannelRepository;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new WorkflowChannelRepository(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  const rec: WorkflowChannel = {
    workflowId: 'wf-1-2',
    channelId: 'C123',
    requestedBy: 'U1',
    lobbyChannelId: 'CLOBBY',
    lobbyThreadTs: 't1',
    harnessPreset: 'omp+claude',
    repoUrl: 'https://example.com/repo.git',
    createdAt: new Date().toISOString(),
  };

  it('round-trips a mapping by workflow id and by channel id', () => {
    repo.save(rec);
    expect(repo.getByWorkflowId('wf-1-2')).toEqual(rec);
    expect(repo.getByChannelId('C123')).toEqual(rec);
  });

  it('returns null for an unknown channel or workflow', () => {
    expect(repo.getByChannelId('nope')).toBeNull();
    expect(repo.getByWorkflowId('nope')).toBeNull();
  });

  it('upserts on repeated save (channel re-map)', () => {
    repo.save(rec);
    repo.save({ ...rec, channelId: 'C999' });
    expect(repo.getByWorkflowId('wf-1-2')?.channelId).toBe('C999');
    expect(repo.getByChannelId('C123')).toBeNull();
  });

  it('lists and deletes mappings', () => {
    repo.save(rec);
    repo.save({ ...rec, workflowId: 'wf-3-4', channelId: 'C456' });
    expect(repo.list().map((r) => r.workflowId).sort()).toEqual(['wf-1-2', 'wf-3-4']);
    repo.delete('wf-1-2');
    expect(repo.getByWorkflowId('wf-1-2')).toBeNull();
    expect(repo.list()).toHaveLength(1);
  });

  it('preserves optional fields left undefined', () => {
    repo.save({ workflowId: 'wf-9', channelId: 'C9', createdAt: new Date().toISOString() });
    const loaded = repo.getByWorkflowId('wf-9');
    expect(loaded?.requestedBy).toBeUndefined();
    expect(loaded?.repoUrl).toBeUndefined();
  });
});
