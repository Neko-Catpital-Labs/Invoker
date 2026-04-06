/**
 * Shared flag: when false, RepoPool.ensureClone skips `git fetch` for that call chain.
 * Restart-workflow sets false for the executeTasks batch; rebase-and-retry leaves true.
 */
export const remoteFetchForPool = { enabled: true };
