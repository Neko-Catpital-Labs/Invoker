/**
 * Controls whether per-task and rebase-and-retry workspace cleanup runs.
 *
 * Background: branch hashes now embed `attemptId`, guaranteeing that every
 * attempt produces a brand-new branch/worktree path. Cleaning up old
 * worktrees and branch refs is therefore unnecessary for correctness, and
 * historically these cleanup paths have caused "cannot lock ref" / "cannot
 * force update branch" failures on the SSH remote when state from earlier
 * attempts collided with newly computed paths.
 *
 * Default: cleanup is DISABLED. Set INVOKER_ENABLE_WORKSPACE_CLEANUP=1 to
 * re-enable for diagnostic or disk-pressure scenarios.
 */
export function isWorkspaceCleanupEnabled(): boolean {
  return process.env.INVOKER_ENABLE_WORKSPACE_CLEANUP === '1';
}
