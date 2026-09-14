import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SlackPlanDraftRepository } from '../slack-plan-draft-repository.js';
import { PlanningDraftRepository } from '../planning-draft-repository.js';
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

  it('links review rows to the exact immutable doctor-approved draft', () => {
    const planningDrafts = new PlanningDraftRepository(adapter);
    const planText = 'name: test\ntasks:\n  - id: task\n    description: Test';
    const approved = planningDrafts.createCurrent('T1', planText);

    const draft = repository.create({
      channelId: 'C1',
      threadTs: 'T1',
      planningDraftId: approved.id,
      planText,
      summaryJson: '{}',
      repoUrl: 'https://github.com/acme/repo.git',
      harnessPreset: 'codex',
      workingDir: '/tmp/repo',
      requestedBy: 'U1',
    });

    expect(repository.resolvePlanText(draft)).toBe(planText);
    expect(repository.get(draft.draftId, draft.version)?.planningDraftId).toBe(approved.id);
  });

  it('rejects review text that differs from its immutable draft', () => {
    const planningDrafts = new PlanningDraftRepository(adapter);
    const approved = planningDrafts.createCurrent('T1', 'name: approved');

    expect(() => repository.create({
      channelId: 'C1',
      threadTs: 'T1',
      planningDraftId: approved.id,
      planText: 'name: changed',
      summaryJson: '{}',
      repoUrl: 'https://github.com/acme/repo.git',
      harnessPreset: 'codex',
      workingDir: '/tmp/repo',
      requestedBy: 'U1',
    })).toThrow(/exact current doctor-approved/);
  });

  it('rejecting an older review does not supersede a newer current draft', () => {
    const planningDrafts = new PlanningDraftRepository(adapter);
    const first = planningDrafts.createCurrent('T1', 'name: first');
    const review = repository.create({
      channelId: 'C1',
      threadTs: 'T1',
      planningDraftId: first.id,
      planText: first.planText,
      summaryJson: '{}',
      repoUrl: 'https://github.com/acme/repo.git',
      harnessPreset: 'codex',
      workingDir: '/tmp/repo',
      requestedBy: 'U1',
    });
    const second = planningDrafts.createCurrent('T1', 'name: second');

    repository.decide(review, 'rejected', 'U1');

    expect(planningDrafts.getCurrent('T1')?.id).toBe(second.id);
  });
});
