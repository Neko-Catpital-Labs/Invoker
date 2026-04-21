import type { TaskState } from '@invoker/workflow-core';

export type AutoFixFailureDisposition = 'auto_fix_code' | 'fail_fast';

export function classifyAutoFixFailure(task: TaskState | undefined): {
  disposition: AutoFixFailureDisposition;
  reason: string;
} {
  if (!task) {
    return { disposition: 'fail_fast', reason: 'task-missing' };
  }

  const error = task.execution?.error ?? '';
  const command = task.config?.command ?? '';

  const broadLintFailure =
    /\beslint\b/i.test(command) ||
    /\beslint packages\/\b/i.test(error) ||
    /\bno-explicit-any\b/.test(error) ||
    /\bno-undef\b/.test(error) ||
    /✖\s+\d+\s+problems?/.test(error);
  if (broadLintFailure) {
    return { disposition: 'fail_fast', reason: 'broad-lint-failure' };
  }

  const dtsBuildFailure =
    /\bTS6307:/.test(error) ||
    /error occurred in dts build/i.test(error) ||
    /Projects must list all files or use an 'include' pattern/i.test(error);
  if (dtsBuildFailure) {
    return { disposition: 'fail_fast', reason: 'dts-build-config-failure' };
  }

  return { disposition: 'auto_fix_code', reason: 'auto-fix-eligible' };
}
