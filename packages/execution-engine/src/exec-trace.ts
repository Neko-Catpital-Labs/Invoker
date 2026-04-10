/**
 * Console grep tag for the execution path from task restart IPC through
 * TaskRunner → executor.start() → setupTaskBranch() (or RepoPool preserve
 * when repoUrl + pool — setupTaskBranch is skipped).
 */
export const RESTART_TO_BRANCH_TRACE = '[restart→branch]';
