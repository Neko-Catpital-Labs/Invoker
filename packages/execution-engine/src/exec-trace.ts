/**
 * Console grep tag for the execution path from task restart IPC through
 * TaskRunner → executor.start() → setupTaskBranch() (or RepoPool preserve
 * when repoUrl + pool — setupTaskBranch is skipped).
 */
export const RESTART_TO_BRANCH_TRACE = '[restart→branch]';

export function executionTraceEnabled(): boolean {
  return process.env.INVOKER_TRACE_EXECUTION === '1';
}

export function traceExecution(...args: unknown[]): void {
  if (!executionTraceEnabled()) return;
  console.log(...args);
}
