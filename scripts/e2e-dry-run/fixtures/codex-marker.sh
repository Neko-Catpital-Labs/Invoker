#!/usr/bin/env bash
# Dummy Codex CLI for e2e-dry-run: no network, instant exit 0.
# Invoked like: codex exec [--full-auto] <prompt>
set -eu

# Parse args — skip flags/subcommands, just record invocation.
while [ "$#" -gt 0 ]; do
  shift
done

ROOT="${INVOKER_E2E_MARKER_ROOT:-}"
if [ -n "$ROOT" ]; then
  mkdir -p "$ROOT"
  ts="$(date +%s)"
  echo ok >"$ROOT/codex-${ts}-$$.marker"
fi

# Auto-resolve merge conflicts (no-op when none exist).
if git rev-parse --git-dir >/dev/null 2>&1; then
  UNMERGED=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
  if [ -n "$UNMERGED" ]; then
    git checkout --theirs . 2>/dev/null || true
    git add -A 2>/dev/null || true
    git -c user.name='e2e-stub' -c user.email='stub@test' \
      commit --no-edit 2>/dev/null || true
  fi
fi

exit 0
