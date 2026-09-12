import { describe, expect, it } from 'vitest';
import { summarizePlanText } from '../plan-summary.js';

describe('summarizePlanText', () => {
  it('preserves multiline task descriptions for draft review', () => {
    const summary = summarizePlanText(`
name: Greeting fix
tasks:
  - id: fix-greeting
    description: |
      Review claim: Fix greeting punctuation.
      Review lane: behavior
      Safety invariant: Preserve existing inputs.
    command: pnpm test
    dependencies: []
`);

    expect(summary?.taskGroups[0]?.tasks[0]).toBe(
      'Review claim: Fix greeting punctuation.\nReview lane: behavior\nSafety invariant: Preserve existing inputs.',
    );
  });
});
