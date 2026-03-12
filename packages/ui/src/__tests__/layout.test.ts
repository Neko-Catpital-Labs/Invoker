/**
 * Tests for layoutNodes — the Sugiyama-inspired DAG layout algorithm.
 */

import { describe, it, expect } from 'vitest';
import { layoutNodes, countCrossings } from '../lib/layout.js';
import type { TaskState } from '../types.js';

function makeTask(
  id: string,
  deps: string[] = [],
): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status: 'pending',
    dependencies: deps,
    createdAt: new Date('2025-01-01'),
    config: {},
    execution: {},
  };
}

describe('layoutNodes', () => {
  it('positions nodes at correct x/y for each level', () => {
    // A -> B -> C (linear chain, 3 levels)
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['b']),
    ];

    const positions = layoutNodes(tasks);

    expect(positions.size).toBe(3);

    const posA = positions.get('a')!;
    const posB = positions.get('b')!;
    const posC = positions.get('c')!;

    // Level 0, 1, 2 — x should increase
    expect(posA.x).toBeLessThan(posB.x);
    expect(posB.x).toBeLessThan(posC.x);

    // Single node at each level, so y should be the same (centered)
    expect(posA.y).toBe(posB.y);
    expect(posB.y).toBe(posC.y);
  });

  it('handles single node', () => {
    const tasks = [makeTask('solo')];

    const positions = layoutNodes(tasks);

    expect(positions.size).toBe(1);
    expect(positions.has('solo')).toBe(true);

    const pos = positions.get('solo')!;
    expect(pos.x).toBe(0); // Level 0
    expect(typeof pos.y).toBe('number');
  });

  it('handles disconnected components', () => {
    // Two independent tasks (no dependencies between them)
    const tasks = [
      makeTask('alpha'),
      makeTask('beta'),
    ];

    const positions = layoutNodes(tasks);

    expect(positions.size).toBe(2);

    const posAlpha = positions.get('alpha')!;
    const posBeta = positions.get('beta')!;

    // Both at level 0, same x
    expect(posAlpha.x).toBe(posBeta.x);

    // Different y (stacked vertically)
    expect(posAlpha.y).not.toBe(posBeta.y);
  });

  it('handles empty task list', () => {
    const positions = layoutNodes([]);
    expect(positions.size).toBe(0);
  });

  it('stacks multiple nodes at same level vertically', () => {
    // A -> B, A -> C (B and C at same level)
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['a']),
    ];

    const positions = layoutNodes(tasks);

    const posB = positions.get('b')!;
    const posC = positions.get('c')!;

    // Same level, same x
    expect(posB.x).toBe(posC.x);

    // Different y
    expect(posB.y).not.toBe(posC.y);
  });

  it('gives more vertical space to highly connected nodes', () => {
    // Hub: A -> B, A -> C, A -> D, A -> E (A has 4 connections)
    // Lone: X (0 connections)
    // Both A and X at level 0
    const tasks = [
      makeTask('a'),
      makeTask('x'),
      makeTask('b', ['a']),
      makeTask('c', ['a']),
      makeTask('d', ['a']),
      makeTask('e', ['a']),
    ];

    const positions = layoutNodes(tasks);

    const posA = positions.get('a')!;
    const posX = positions.get('x')!;

    // A and X are both at level 0, stacked vertically
    expect(posA.x).toBe(posX.x);
    expect(posA.y).not.toBe(posX.y);

    // The gap between A and X should be > base gap (40)
    // because A has 4 children (4 connections)
    const gap = Math.abs(posA.y - posX.y) - 80; // subtract NODE_HEIGHT
    expect(gap).toBeGreaterThan(40);
  });

  it('reduces edge crossings in a diamond+crossing pattern', () => {
    // Classic crossing scenario:
    //   a1 -> b2   (cross)
    //   a2 -> b1   (cross)
    // Without reordering: edges cross. With barycenter: b1, b2 reorder to match.
    const tasks = [
      makeTask('a1'),
      makeTask('a2'),
      makeTask('b1', ['a2']),
      makeTask('b2', ['a1']),
    ];

    const positions = layoutNodes(tasks);

    const posA1 = positions.get('a1')!;
    const posA2 = positions.get('a2')!;
    const posB1 = positions.get('b1')!;
    const posB2 = positions.get('b2')!;

    // After barycenter ordering:
    // If a1 is above a2, then b2 (child of a1) should be above b1 (child of a2)
    // This means edges don't cross.
    if (posA1.y < posA2.y) {
      expect(posB2.y).toBeLessThan(posB1.y);
    } else {
      expect(posB1.y).toBeLessThan(posB2.y);
    }
  });

  it('handles complex DAG with multiple levels and fan-out', () => {
    // root -> mid1, mid2; mid1 -> leaf; mid2 -> leaf
    const tasks = [
      makeTask('root'),
      makeTask('mid1', ['root']),
      makeTask('mid2', ['root']),
      makeTask('leaf', ['mid1', 'mid2']),
    ];

    const positions = layoutNodes(tasks);

    expect(positions.size).toBe(4);

    const posRoot = positions.get('root')!;
    const posMid1 = positions.get('mid1')!;
    const posMid2 = positions.get('mid2')!;
    const posLeaf = positions.get('leaf')!;

    // root at level 0, mid at level 1, leaf at level 2
    expect(posRoot.x).toBeLessThan(posMid1.x);
    expect(posMid1.x).toBe(posMid2.x);
    expect(posMid1.x).toBeLessThan(posLeaf.x);

    // Leaf should be roughly centered between mid1 and mid2
    // (median alignment nudges it toward neighbors)
    const midCenter = (posMid1.y + posMid2.y) / 2;
    expect(Math.abs(posLeaf.y - midCenter)).toBeLessThan(100);
  });

  it('preserves correct levels for wide fan-in', () => {
    // a, b, c all feed into d
    const tasks = [
      makeTask('a'),
      makeTask('b'),
      makeTask('c'),
      makeTask('d', ['a', 'b', 'c']),
    ];

    const positions = layoutNodes(tasks);

    const posA = positions.get('a')!;
    const posB = positions.get('b')!;
    const posC = positions.get('c')!;
    const posD = positions.get('d')!;

    // a, b, c at level 0 (same x), d at level 1
    expect(posA.x).toBe(posB.x);
    expect(posB.x).toBe(posC.x);
    expect(posD.x).toBeGreaterThan(posA.x);
  });
});

describe('countCrossings', () => {
  it('returns 0 for parallel non-crossing edges', () => {
    const children = new Map<string, string[]>([
      ['a', ['c']],
      ['b', ['d']],
    ]);

    // a->c and b->d don't cross when order matches
    expect(countCrossings(['a', 'b'], ['c', 'd'], children)).toBe(0);
  });

  it('detects a single crossing', () => {
    const children = new Map<string, string[]>([
      ['a', ['d']],
      ['b', ['c']],
    ]);

    // a->d and b->c cross because a is above b but d is below c
    expect(countCrossings(['a', 'b'], ['c', 'd'], children)).toBe(1);
  });

  it('returns 0 for empty levels', () => {
    const children = new Map<string, string[]>();
    expect(countCrossings([], [], children)).toBe(0);
  });

  it('counts multiple crossings', () => {
    // 3 nodes on each side, fully reversed
    const children = new Map<string, string[]>([
      ['a', ['z']],
      ['b', ['y']],
      ['c', ['x']],
    ]);

    // a->z, b->y, c->x with left=[a,b,c] right=[x,y,z]
    // All 3 pairs cross: (a->z,b->y), (a->z,c->x), (b->y,c->x)
    expect(countCrossings(['a', 'b', 'c'], ['x', 'y', 'z'], children)).toBe(3);
  });
});
