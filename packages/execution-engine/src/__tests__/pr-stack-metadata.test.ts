import { describe, expect, it } from 'vitest';

import type { PullRequestIssueComment } from '../workers/pr-maintenance-github.js';
import {
  parseMergifyStackMetadata,
  resolveCurrentPullRequestStack,
} from '../workers/pr-stack-metadata.js';

function comment(body: string, updatedAt = '2026-07-07T00:00:00Z'): PullRequestIssueComment {
  return {
    id: updatedAt,
    body,
    updatedAt,
  };
}

describe('pr stack metadata recovery', () => {
  it('prefers the newest hidden marker comment', () => {
    const parsed = parseMergifyStackMetadata([
      comment(
        '<!-- mergify-stack-data: {"stack_id":"old","pull_numbers_bottom_to_top":[1,2]} -->',
        '2026-07-01T00:00:00Z',
      ),
      comment(
        '<!-- mergify-stack-data: {"stack_id":"new","pull_numbers_bottom_to_top":[10,11,12]} -->',
        '2026-07-07T00:00:00Z',
      ),
    ]);

    expect(parsed).toEqual({
      stackId: 'new',
      pulls: [{ number: 10 }, { number: 11 }, { number: 12 }],
    });
  });

  it('preserves bottom-to-top order from the hidden marker', () => {
    const parsed = parseMergifyStackMetadata([
      comment(
        '<!-- mergify-stack-data: {"stack_id":"stack/demo","pull_numbers_bottom_to_top":[2604,2605,2601]} -->',
      ),
    ]);

    expect(parsed?.stackId).toBe('stack/demo');
    expect(parsed?.pulls.map((pull) => pull.number)).toEqual([2604, 2605, 2601]);
  });

  it('accepts modern pull-object markers', () => {
    const parsed = parseMergifyStackMetadata([
      comment(
        '<!-- mergify-stack-data: {"stack_id":"stack-1","pulls":[{"number":10,"head_sha":"abc"},{"number":11,"head_ref_name":"stack/11"}]} -->',
      ),
    ]);

    expect(parsed).toEqual({
      stackId: 'stack-1',
      pulls: [
        { number: 10, headSha: 'abc' },
        { number: 11, headRefName: 'stack/11' },
      ],
    });
  });

  it('falls back to a branch chain when no marker exists', () => {
    const stack = resolveCurrentPullRequestStack([
      {
        number: 5800,
        title: 'Bottom',
        url: 'https://github.com/owner/repo/pull/5800',
        headRefName: 'stack/5800',
        headRefOid: 'sha-5800',
        baseRefName: 'main',
      },
      {
        number: 5801,
        title: 'Middle',
        url: 'https://github.com/owner/repo/pull/5801',
        headRefName: 'stack/5801',
        headRefOid: 'sha-5801',
        baseRefName: 'stack/5800',
      },
      {
        number: 5802,
        title: 'Top',
        url: 'https://github.com/owner/repo/pull/5802',
        headRefName: 'stack/5802',
        headRefOid: 'sha-5802',
        baseRefName: 'stack/5801',
      },
    ], new Map(), 5801, 'main');

    expect(stack.stackId).toBe('branch:5800');
    expect(stack.pulls.map((pull) => pull.number)).toEqual([5800, 5801, 5802]);
  });

  it('falls back to a standalone stack when no branch chain exists', () => {
    const stack = resolveCurrentPullRequestStack([
      {
        number: 5810,
        title: 'Single',
        url: 'https://github.com/owner/repo/pull/5810',
        headRefName: 'stack/5810',
        headRefOid: 'sha-5810',
        baseRefName: 'main',
      },
    ], new Map(), 5810, 'main');

    expect(stack).toEqual({
      stackId: 'single:5810',
      pulls: [{
        number: 5810,
        title: 'Single',
        url: 'https://github.com/owner/repo/pull/5810',
        headRefName: 'stack/5810',
        headRefOid: 'sha-5810',
        baseRefName: 'main',
      }],
    });
  });
});
