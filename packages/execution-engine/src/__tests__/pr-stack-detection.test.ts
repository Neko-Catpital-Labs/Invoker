import { describe, expect, it } from 'vitest';

import { detectStack, type StackPrRecord } from '../pr-stack-detection.js';

function pr(overrides: Partial<StackPrRecord> & { number: number }): StackPrRecord {
  return {
    state: 'OPEN',
    baseRefName: 'master',
    headRefName: `stack/pr-${overrides.number}`,
    headRefOid: `sha-${overrides.number}`,
    ...overrides,
  };
}

describe('detectStack', () => {
  it('Case A: finds a full linear 3-PR stack from the bottom member, bottom-to-top', () => {
    // Models the real #6097->#6098->#6099 "spawn-repair-workflow command" stack.
    const bottom = pr({ number: 9001, baseRefName: 'master', headRefName: 'stack/a' });
    const middle = pr({ number: 9002, baseRefName: 'stack/a', headRefName: 'stack/b' });
    const top = pr({ number: 9003, baseRefName: 'stack/b', headRefName: 'stack/c' });
    const allOpenPrs = [bottom, middle, top];

    const result = detectStack(bottom, allOpenPrs);

    expect(result.members.map((m) => m.number)).toEqual([9001, 9002, 9003]);
    expect(result.stackId).toBe('stack:master:9001,9002,9003');
  });

  it('Case A: finds the same stack when detection starts from the TOP member', () => {
    const bottom = pr({ number: 9001, baseRefName: 'master', headRefName: 'stack/a' });
    const middle = pr({ number: 9002, baseRefName: 'stack/a', headRefName: 'stack/b' });
    const top = pr({ number: 9003, baseRefName: 'stack/b', headRefName: 'stack/c' });
    const allOpenPrs = [bottom, middle, top];

    const result = detectStack(top, allOpenPrs);

    expect(result.members.map((m) => m.number)).toEqual([9001, 9002, 9003]);
  });

  it('Case B: finds a 2-PR stack where the bottom already has failing checks', () => {
    // Models the real #6146->#6173 "Review Gate CI Repair" stack.
    const bottom = pr({ number: 9101, baseRefName: 'master', headRefName: 'stack/x' });
    const top = pr({ number: 9102, baseRefName: 'stack/x', headRefName: 'stack/y' });
    const allOpenPrs = [bottom, top];

    const result = detectStack(bottom, allOpenPrs);

    expect(result.members.map((m) => m.number)).toEqual([9101, 9102]);
    expect(result.stackId).toBe('stack:master:9101,9102');
  });

  it('degenerates to a stack of one when the PR is not on a stack/-prefixed branch', () => {
    const failing = pr({ number: 42, headRefName: 'feature/plain-branch' });

    const result = detectStack(failing, [failing]);

    expect(result.members).toEqual([failing]);
    expect(result.stackId).toBe('single:42');
  });

  it('degenerates to a stack of one when no sibling PRs share the branch chain', () => {
    const failing = pr({ number: 9201, baseRefName: 'master', headRefName: 'stack/lonely' });
    const unrelated = pr({ number: 9202, baseRefName: 'master', headRefName: 'stack/other' });

    const result = detectStack(failing, [failing, unrelated]);

    expect(result.members.map((m) => m.number)).toEqual([9201]);
  });

  it('stops growing upward on an ambiguous branch (two open children of the same base)', () => {
    const bottom = pr({ number: 9301, baseRefName: 'master', headRefName: 'stack/a' });
    const childOne = pr({ number: 9302, baseRefName: 'stack/a', headRefName: 'stack/b1' });
    const childTwo = pr({ number: 9303, baseRefName: 'stack/a', headRefName: 'stack/b2' });

    const result = detectStack(bottom, [bottom, childOne, childTwo]);

    expect(result.members.map((m) => m.number)).toEqual([9301]);
  });

  it('stops walking downward when a lower stack PR is missing from the open set (already merged)', () => {
    // Models #6146/#6173: the bottom PR merged, only the top sibling is still open.
    const top = pr({ number: 9102, baseRefName: 'stack/x', headRefName: 'stack/y' });

    const result = detectStack(top, [top]);

    expect(result.members.map((m) => m.number)).toEqual([9102]);
  });

  it('excludes non-OPEN PRs from the walked stack even if passed in allOpenPrs', () => {
    const bottom = pr({ number: 9401, baseRefName: 'master', headRefName: 'stack/a' });
    const mergedMiddle = pr({ number: 9402, baseRefName: 'stack/a', headRefName: 'stack/b', state: 'MERGED' });

    const result = detectStack(bottom, [bottom, mergedMiddle]);

    expect(result.members.map((m) => m.number)).toEqual([9401]);
  });
});
