import { describe, it, expect } from 'vitest';
import {
  isAdminBypassRepairTask,
  isE2eRepairWorkflow,
  isCleanupEligibleWorkflow,
} from '../workers/idle-task-cleanup-policy.js';

describe('isAdminBypassRepairTask', () => {
  it('matches a repair-pr plan name with a numeric PR and a fingerprint suffix', () => {
    expect(isAdminBypassRepairTask('repair-pr-801-ab12cd34ef56ab12')).toBe(true);
  });

  it('rejects a near-miss with no fingerprint suffix', () => {
    expect(isAdminBypassRepairTask('repair-pr-801')).toBe(false);
    expect(isAdminBypassRepairTask('repair-pr-801-')).toBe(false);
  });

  it('rejects an unrelated workflow name', () => {
    expect(isAdminBypassRepairTask('my-feature-workflow')).toBe(false);
    expect(isAdminBypassRepairTask('close-pr-801-ab12cd34')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isAdminBypassRepairTask(undefined)).toBe(false);
  });
});

describe('isE2eRepairWorkflow', () => {
  it('matches a workflow description carrying the ci-regression-watch marker', () => {
    expect(
      isE2eRepairWorkflow('invoker-ci-regression-watch: first-bad-sha=abc123; job=playwright-6-of-9'),
    ).toBe(true);
  });

  it('matches when the marker appears mid-description', () => {
    expect(
      isE2eRepairWorkflow('Fix CI regression. invoker-ci-regression-watch: first-bad-sha=abc123; job=unit'),
    ).toBe(true);
  });

  it('rejects an unrelated description that merely mentions ci-regression-watch by name', () => {
    expect(isE2eRepairWorkflow('See invoker-ci-regression-watch docs for context')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isE2eRepairWorkflow(undefined)).toBe(false);
  });
});

describe('isCleanupEligibleWorkflow', () => {
  it('is eligible via the admin-bypass-repair workflow name alone', () => {
    expect(isCleanupEligibleWorkflow({ name: 'repair-pr-42-deadbeef00000000', description: 'unrelated' })).toBe(true);
  });

  it('is eligible via the e2e-repair workflow description marker alone', () => {
    expect(
      isCleanupEligibleWorkflow({
        name: 'CI regression: abc123-unit',
        description: 'invoker-ci-regression-watch: first-bad-sha=abc; job=unit',
      }),
    ).toBe(true);
  });

  it('is not eligible when neither signal matches', () => {
    expect(isCleanupEligibleWorkflow({ name: 'my-other-workflow', description: 'plain workflow' })).toBe(false);
  });
});
