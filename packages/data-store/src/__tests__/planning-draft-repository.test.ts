import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { PlanningDraftRepository } from '../planning-draft-repository.js';

describe('PlanningDraftRepository', () => {
  let adapter: SQLiteAdapter;
  let repo: PlanningDraftRepository;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new PlanningDraftRepository(adapter);
  });

  afterEach(() => adapter.close());

  it('creates immutable versions with at most one current draft', () => {
    const first = repo.createCurrent('conversation-1', 'name: First');
    const second = repo.createCurrent('conversation-1', 'name: Second');

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(repo.getCurrent('conversation-1')).toEqual(second);
    expect(repo.get(first.id)?.status).toBe('superseded');
    expect(repo.get(second.id)?.status).toBe('current');
  });

  it('stores a hash of the exact normalized plan text', () => {
    const draft = repo.createCurrent('conversation-1', '  name: Exact  \n');

    expect(draft.planText).toBe('name: Exact');
    expect(draft.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('marks only the current immutable version submitted', () => {
    const draft = repo.createCurrent('conversation-1', 'name: Submit');
    repo.markSubmitted(draft.id);

    expect(repo.get(draft.id)?.status).toBe('submitted');
    expect(repo.getCurrent('conversation-1')).toBeUndefined();
  });
});
