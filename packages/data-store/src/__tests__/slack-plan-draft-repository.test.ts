import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SlackPlanDraftRepository } from '../slack-plan-draft-repository.js';
import { SQLiteAdapter } from '../sqlite-adapter.js';

describe('SlackPlanDraftRepository', () => {
  let adapter: SQLiteAdapter;
  let repository: SlackPlanDraftRepository;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    repository = new SlackPlanDraftRepository(adapter);
  });

  afterEach(() => adapter.close());

  it('does not make a card approvable until its message and YAML attachment are bound', () => {
    const draft = repository.create({
      channelId: 'C1',
      threadTs: 'T1',
      planText: 'name: test\ntasks:\n  - id: task\n    description: Test',
      summaryJson: '{}',
      repoUrl: 'https://github.com/acme/repo.git',
      harnessPreset: 'codex',
      workingDir: '/tmp/repo',
      requestedBy: 'U1',
    });

    expect(draft.status).toBe('preparing');
    expect(() => repository.markReady(draft)).toThrow(/message and YAML attachment/);
    repository.bindMessage(draft, '123.456');
    repository.bindAttachment(draft, 'F1');
    repository.markReady(draft);
    expect(repository.get(draft.draftId, draft.version)?.status).toBe('ready');
  });

  it('claims a ready card only once with a deterministic execution key', () => {
    const draft = repository.create({
      channelId: 'C1',
      threadTs: 'T1',
      planText: 'name: test\ntasks:\n  - id: task\n    description: Test',
      summaryJson: '{}',
      repoUrl: 'https://github.com/acme/repo.git',
      harnessPreset: 'codex',
      workingDir: '/tmp/repo',
      requestedBy: 'U1',
    });
    repository.bindMessage(draft, '123.456');
    repository.bindAttachment(draft, 'F1');
    repository.markReady(draft);

    expect(repository.claim(draft)).toBe(`${draft.draftId}:${draft.version}`);
    expect(repository.claim(draft)).toBeUndefined();
    expect(repository.get(draft.draftId, draft.version)).toMatchObject({
      status: 'submitting',
      executionKey: `${draft.draftId}:${draft.version}`,
    });
  });
});
