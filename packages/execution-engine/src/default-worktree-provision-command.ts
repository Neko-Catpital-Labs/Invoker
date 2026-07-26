/**
 * Keep local managed worktrees runnable for pnpm repos without forcing every
 * task command to repeat dependency setup. This mirrors managed SSH bootstrap:
 * only hydrate when a pnpm lockfile exists and the worktree has no node_modules.
 */
export const DEFAULT_WORKTREE_PROVISION_COMMAND = `ensure_managed_pnpm_workspace() {
  if [ "\${INVOKER_SKIP_MANAGED_PNPM_INSTALL:-}" = "1" ]; then
    return 0
  fi
  if [ ! -f pnpm-lock.yaml ] || [ -d node_modules ]; then
    return 0
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "[WorktreeExecutor] pnpm-lock.yaml found and node_modules missing, but pnpm is not installed." >&2
    return 127
  fi
  echo "[WorktreeExecutor] Installing pnpm dependencies for managed worktree..."
  pnpm install --frozen-lockfile
}
ensure_managed_pnpm_workspace
`;
