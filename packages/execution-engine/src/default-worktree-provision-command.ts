/**
 * Managed worktrees no longer run any implicit dependency/bootstrap setup.
 * Repos must do their own hydration inside the task command or a repo-owned wrapper.
 */
export const DEFAULT_WORKTREE_PROVISION_COMMAND = '';
