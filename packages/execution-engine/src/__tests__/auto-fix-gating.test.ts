import { describe, expect, it } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';

import {
  isLivenessFailureTask,
  isRequeueEligibleFailureTask,
  isSshOauthExpiredFailureTask,
} from '../auto-fix-gating.js';

function taskWithFailureClass(
  failureClass: TaskState['execution']['failureClass'],
): Pick<TaskState, 'execution'> {
  return { execution: { failureClass } };
}

describe('requeue eligibility predicates', () => {
  it('treats ssh-oauth-session-expired as requeue-eligible but not a liveness failure', () => {
    const task = taskWithFailureClass('ssh-oauth-session-expired');
    expect(isSshOauthExpiredFailureTask(task)).toBe(true);
    expect(isRequeueEligibleFailureTask(task)).toBe(true);
    expect(isLivenessFailureTask(task)).toBe(false);
  });

  it('treats liveness_stall as both a liveness failure and requeue-eligible', () => {
    const task = taskWithFailureClass('liveness_stall');
    expect(isLivenessFailureTask(task)).toBe(true);
    expect(isRequeueEligibleFailureTask(task)).toBe(true);
    expect(isSshOauthExpiredFailureTask(task)).toBe(false);
  });

  it('treats other SSH infra classes and unclassified failures as neither', () => {
    for (const failureClass of ['ssh-worktree-missing' as const, undefined]) {
      const task = taskWithFailureClass(failureClass);
      expect(isLivenessFailureTask(task)).toBe(false);
      expect(isSshOauthExpiredFailureTask(task)).toBe(false);
      expect(isRequeueEligibleFailureTask(task)).toBe(false);
    }
  });
});
