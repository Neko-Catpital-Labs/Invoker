/**
 * Default shell command for provisioning a worktree after clone (local or remote).
 * Kept in one place so WorktreeExecutor, SshExecutor, and docs stay aligned.
 */
export const DEFAULT_WORKTREE_PROVISION_COMMAND =
  'if [ ! -f package.json ] && [ ! -f pnpm-workspace.yaml ]; then \
    echo "[provision] No package.json/pnpm-workspace.yaml found; skipping pnpm install"; \
    exit 0; \
  fi; \
  invoker_pnpm_install_with_dev() { NODE_ENV=development PNPM_CONFIG_PRODUCTION=false npm_config_production=false NPM_CONFIG_PRODUCTION=false pnpm install --prod=false "$@"; }; \
  if ! invoker_pnpm_install_with_dev --frozen-lockfile; then \
    echo "[provision] frozen-lockfile install failed; refreshing lockfile and retrying"; \
    invoker_pnpm_install_with_dev --lockfile-only; \
    invoker_pnpm_install_with_dev --frozen-lockfile; \
  fi && ( \
  [ ! -f pnpm-workspace.yaml ] || ( \
    echo "[provision] pnpm config production (debug): $(PNPM_CONFIG_PRODUCTION=false npm_config_production=false NPM_CONFIG_PRODUCTION=false pnpm config get production 2>/dev/null || echo unknown)" && \
    ( [ -f packages/transport/node_modules/@types/node/package.json ] && echo "[provision] @types/node linked under packages/transport" ) || \
    ( FOUND_TYPES=0 && for f in node_modules/.pnpm/@types+node@*/node_modules/@types/node/package.json; do [ -f "$f" ] && FOUND_TYPES=1 && echo "[provision] @types/node in pnpm store: $f" && break; done && [ "$FOUND_TYPES" -eq 1 ] ) || \
    ( \
      echo "[provision] Missing @types/node after install (not under transport or pnpm virtual store)" && \
      echo "[provision] transport @types dir:" && \
      ls -la packages/transport/node_modules/@types 2>/dev/null || true && \
      echo "[provision] root @types dir:" && \
      ls -la node_modules/@types 2>/dev/null || true && \
      echo "[provision] pnpm -C packages/transport list @types/node (debug):" && \
      pnpm -C packages/transport list --depth 0 @types/node 2>/dev/null || true && \
      echo "[provision] pnpm store candidates under node_modules/.pnpm (debug):" && \
      ls -la node_modules/.pnpm/@types+node* 2>/dev/null || true && \
      exit 1 \
    ) \
  ) \
  )';
