import { describe, it, expect } from 'vitest';

import { validateWorkResponse } from '../validation.js';

// Repro guards for the #1757 bug class as it occurs in the CORE contract validator
// (sibling of the make-pr stack validator in execution-engine/pr-authoring.ts).
//
// Class: identifier fields were validated with `.length === 0`, so a
// whitespace-only id / dependency ("   ") passed validation and could be
// persisted as a blank identifier, causing downstream identifier mismatches.
// Fixed by validating trimmed content (`.trim().length === 0`).

interface ReviewArtifact {
  id: string;
  title: string;
  required: boolean;
  status: string;
  generation: number;
  dependsOn?: string[];
}

function workResponseWithArtifacts(artifacts: ReviewArtifact[]): unknown {
  return {
    requestId: 'req-1',
    actionId: 'task-1',
    executionGeneration: 0,
    status: 'completed',
    outputs: {
      exitCode: 0,
      reviewGate: {
        activeGeneration: 1,
        completion: { required: 'all', status: 'approved' },
        artifacts,
      },
    },
  };
}

describe('repro #1757 (contracts): review-gate artifact identifier validation', () => {
  it('rejects a whitespace-only artifact id (was accepted via .length === 0)', () => {
    const result = validateWorkResponse(workResponseWithArtifacts([
      { id: '   ', title: 'Blank', required: true, status: 'open', generation: 1 },
    ]));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('outputs.reviewGate.artifacts[0].id must be a non-empty string');
  });

  it('rejects a whitespace-only dependency (was accepted via .length === 0)', () => {
    const result = validateWorkResponse(workResponseWithArtifacts([
      { id: 'a', title: 'A', required: true, status: 'approved', generation: 1 },
      { id: 'b', title: 'B', required: true, status: 'open', generation: 1, dependsOn: ['   '] },
    ]));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('dependsOn must contain non-empty artifact ids');
  });

  it('still accepts a well-formed two-artifact stack (no false positives)', () => {
    const result = validateWorkResponse(workResponseWithArtifacts([
      { id: 'a', title: 'A', required: true, status: 'approved', generation: 1 },
      { id: 'b', title: 'B', required: true, status: 'open', generation: 1, dependsOn: ['a'] },
    ]));
    expect(result.valid).toBe(true);
  });
});
