export const DEFAULT_WORKTREE_PROVISION_COMMAND = `set -euo pipefail

if [ "\${INVOKER_SKIP_MANAGED_PNPM_INSTALL:-}" = "1" ]; then
  exit 0
fi

if [ ! -f pnpm-lock.yaml ] || [ -d node_modules ]; then
  exit 0
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[WorktreeExecutor] pnpm-lock.yaml found and node_modules missing, but pnpm is not installed." >&2
  exit 127
fi

echo "[WorktreeExecutor] Installing pnpm dependencies for managed worktree..."
pnpm install --frozen-lockfile
`;
