import { describe, expect, it } from 'vitest';
import {
  assertWorkflowConsistent,
  assertWorkflowPatchConsistent,
} from '../state-invariants.js';

const depA = {
  workflowId: 'upstream-a',
  taskId: '__merge__',
  requiredStatus: 'completed' as const,
  gatePolicy: 'review_ready' as const,
};

const depB = {
  workflowId: 'upstream-b',
  taskId: '__merge__',
  requiredStatus: 'completed' as const,
  gatePolicy: 'completed' as const,
};

function workflow(overrides = {}) {
  return {
    id: 'workflow-1',
    name: 'Workflow 1',
    generation: 0,
    ...overrides,
  };
}

describe('state invariants', () => {
  it('accepts a valid workflow with external dependencies', () => {
    expect(() => assertWorkflowConsistent(workflow({ externalDependencies: [depA] }))).not.toThrow();
  });

  it('rejects empty externalDependencies when present', () => {
    expect(() => assertWorkflowConsistent(workflow({ externalDependencies: [] }))).toThrow(/externalDependencies must be non-empty/);
  });

  it('rejects invalid gatePolicy and requiredStatus values', () => {
    expect(() => assertWorkflowConsistent(workflow({
      externalDependencies: [{ ...depA, gatePolicy: 'approved' }],
    }))).toThrow(/gatePolicy/);

    expect(() => assertWorkflowConsistent(workflow({
      externalDependencies: [{ ...depA, requiredStatus: 'review_ready' }],
    }))).toThrow(/requiredStatus/);
  });

  it('rejects null, negative, and non-integer generations', () => {
    expect(() => assertWorkflowConsistent(workflow({ generation: null }))).toThrow(/generation/);
    expect(() => assertWorkflowConsistent(workflow({ generation: -1 }))).toThrow(/generation/);
    expect(() => assertWorkflowConsistent(workflow({ generation: 1.5 }))).toThrow(/generation/);
  });

  it('rejects losing external dependencies without removal history', () => {
    const before = workflow({ externalDependencies: [depA, depB] });
    const after = workflow({ externalDependencies: [depB] });

    expect(() => assertWorkflowPatchConsistent(before, after, {})).toThrow(/without externalDependencyChanges/);
  });

  it('accepts a detach-style clear with before-only removal records', () => {
    const before = workflow({ externalDependencies: [depA, depB] });
    const after = workflow();

    expect(() => assertWorkflowPatchConsistent(before, after, {
      externalDependencyChanges: [
        { before: depA, changedAt: '2026-06-13T00:00:00.000Z' },
        { before: depB, changedAt: '2026-06-13T00:00:00.000Z' },
      ],
    })).not.toThrow();
  });
});
