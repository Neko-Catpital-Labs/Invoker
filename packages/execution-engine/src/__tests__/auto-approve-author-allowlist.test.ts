import type { TaskState } from '@invoker/workflow-core';
import { describe, expect, it } from 'vitest';

import {
  authorsFromConfigValue,
  createGithubPrAuthorLookup,
  createPersistedAutoApproveAuthorGate,
  evaluateAutoApproveAuthorGate,
  mappedPrFromWorkflowTasks,
  normalizeAutoApproveAuthors,
  parseGithubPrRef,
} from '../workers/auto-approve-author-allowlist.js';

function task(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/__merge__wf-1',
    description: 'Merge',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    config: { id: '__merge__wf-1', workflowId: 'wf-1', isMergeNode: true, ...config },
    execution: {
      generation: 1,
      reviewId: '99',
      reviewUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/99',
      ...execution,
    },
    taskStateVersion: 1,
    ...rest,
  } as TaskState;
}

describe('auto-approve authors in config.json', () => {
  it('normalizes logins and de-dupes case-insensitively', () => {
    expect(normalizeAutoApproveAuthors(['EdbertChan', 'edbertchan', ' OtherUser ', ''])).toEqual([
      'EdbertChan',
      'OtherUser',
    ]);
  });

  it('fails closed when the config key is missing, empty, or not a string array', () => {
    expect(authorsFromConfigValue(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(authorsFromConfigValue([])).toEqual({ ok: false, reason: 'empty' });
    expect(authorsFromConfigValue(['  '])).toEqual({ ok: false, reason: 'empty' });
    expect(authorsFromConfigValue('EdbertChan')).toEqual({ ok: false, reason: 'unreadable' });
    expect(authorsFromConfigValue([42])).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('re-reads whatever the config callback returns each call', async () => {
    let value: unknown = ['EdbertChan'];
    const gate = createPersistedAutoApproveAuthorGate({
      readAllowlist: () => authorsFromConfigValue(value),
      loadTask: (taskId) => task({ id: taskId }),
      loadTasks: () => [task()],
      lookupPrAuthor: async () => 'EdbertChan',
      defaultRepo: 'Neko-Catpital-Labs/Invoker',
    });
    expect(await gate('wf-1/task-1')).toMatchObject({ allowed: true, author: 'EdbertChan' });
    value = ['SomeoneElse'];
    expect(await gate('wf-1/task-1')).toEqual({ allowed: false, reason: 'author-not-allowlisted' });
  });
});

describe('PR mapping and author gate', () => {
  it('parses a PR number and repo from a GitHub URL', () => {
    expect(parseGithubPrRef(undefined, 'https://github.com/Neko-Catpital-Labs/Invoker/pull/99/files'))
      .toEqual({ repo: 'Neko-Catpital-Labs/Invoker', number: '99' });
    expect(parseGithubPrRef('#12', undefined)).toEqual({ number: '12' });
    expect(parseGithubPrRef('nope', 'not-a-url')).toBeNull();
  });

  it('reads review id/url off the merge node', () => {
    expect(mappedPrFromWorkflowTasks([task()])).toEqual({
      reviewId: '99',
      reviewUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/99',
    });
    expect(mappedPrFromWorkflowTasks([task({
      config: { isMergeNode: false },
      execution: { reviewId: undefined, reviewUrl: undefined },
    })])).toBeNull();
  });

  it('allows only allowlisted PR authors and fails closed otherwise', () => {
    const allowlist = { ok: true as const, authors: new Set(['edbertchan']) };
    const mappedPr = { reviewId: '99', reviewUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/99' };
    expect(evaluateAutoApproveAuthorGate({
      allowlist,
      mappedPr,
      prAuthor: 'EdbertChan',
      defaultRepo: 'Neko-Catpital-Labs/Invoker',
    })).toEqual({
      allowed: true,
      author: 'EdbertChan',
      prNumber: '99',
      repo: 'Neko-Catpital-Labs/Invoker',
    });
    expect(evaluateAutoApproveAuthorGate({
      allowlist,
      mappedPr,
      prAuthor: 'someone-else',
      defaultRepo: 'Neko-Catpital-Labs/Invoker',
    })).toEqual({ allowed: false, reason: 'author-not-allowlisted' });
    expect(evaluateAutoApproveAuthorGate({
      allowlist: { ok: false, reason: 'missing' },
      mappedPr,
      prAuthor: 'EdbertChan',
      defaultRepo: 'Neko-Catpital-Labs/Invoker',
    })).toEqual({ allowed: false, reason: 'allowlist-missing' });
    expect(evaluateAutoApproveAuthorGate({
      allowlist,
      mappedPr: null,
      prAuthor: 'EdbertChan',
      defaultRepo: 'Neko-Catpital-Labs/Invoker',
    })).toEqual({ allowed: false, reason: 'no-mapped-pr' });
  });

  it('looks up the PR author with gh', async () => {
    const lookup = createGithubPrAuthorLookup({
      defaultRepo: 'Neko-Catpital-Labs/Invoker',
      run: async () => ({
        code: 0,
        signal: null,
        stdout: JSON.stringify({ author: { login: 'EdbertChan' } }),
        stderr: '',
        timedOut: false,
      }),
    });
    expect(await lookup({ number: '99' })).toBe('EdbertChan');
  });
});
