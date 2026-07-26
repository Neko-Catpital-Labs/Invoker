#!/usr/bin/env bash
set -euo pipefail

DOC="${1:-docs/persistence-architecture-single-writer.md}"

fail() {
  printf 'verify-empty-canonical-sweeps: %s\n' "$1" >&2
  exit 1
}

if [[ ! -f "$DOC" ]]; then
  fail "missing target doc: $DOC"
fi

if ! command -v rg >/dev/null 2>&1; then
  fail "rg is required"
fi

stale_tokens=(
  'invoker:restart-task'
  'rebase-and-retry'
  'recreate-with-rebase'
  '/restart'
  'restartTask('
  'rebaseAndRetry('
  'set executor'
  'GitHub PR'
  'pull_request'
)

for token in "${stale_tokens[@]}"; do
  if rg -n --fixed-strings -- "$token" "$DOC"; then
    fail "stale canonical reference remains: $token"
  fi
done

stale_merge_labels=(
  'manual | github'
  'github | manual'
  'manual | automatic | github'
  'github, manual'
  'mergeMode: github'
  'mergeMode=github'
  'merge-mode: github'
  'merge-mode=github'
  '`github`'
)

for token in "${stale_merge_labels[@]}"; do
  if rg -n --fixed-strings -- "$token" "$DOC"; then
    fail "stale merge-mode label remains: $token"
  fi
done

if ! rg -n --fixed-strings -- '| `invoker:retry-task` |' "$DOC" >/dev/null; then
  fail "missing canonical GUI retry task surface"
fi

if ! rg -n --fixed-strings -- '| `retry-task` |' "$DOC" >/dev/null; then
  fail "missing canonical headless retry task surface"
fi

if ! rg -n --fixed-strings -- '| `invoker:rebase-retry` |' "$DOC" >/dev/null; then
  fail "missing canonical GUI rebase retry surface"
fi

if ! rg -n --fixed-strings -- '| `invoker:rebase-recreate` |' "$DOC" >/dev/null; then
  fail "missing canonical GUI rebase recreate surface"
fi

if ! rg -n --fixed-strings -- '| `rebase-retry` / `rebase-recreate` |' "$DOC" >/dev/null; then
  fail "missing canonical headless fresh-base rebase surfaces"
fi

if ! rg -n --fixed-strings -- '| `set pool` |' "$DOC" >/dev/null; then
  fail "missing canonical headless pool configuration surface"
fi

if ! rg -n --fixed-strings -- 'Values: `manual`, `automatic`, `external_review`' "$DOC" >/dev/null; then
  fail "missing canonical merge-mode values"
fi

if ! rg -n --fixed-strings -- "merge_mode = 'github'" "$DOC" >/dev/null; then
  fail "missing allowed SQLite merge_mode compatibility context"
fi

github_lines="$(rg -n --fixed-strings -i -- 'github' "$DOC" || true)"
if [[ -n "$github_lines" ]]; then
  unexpected_github="$(printf '%s\n' "$github_lines" | grep -Fvi "merge_mode = 'github'" || true)"
  if [[ -n "$unexpected_github" ]]; then
    printf '%s\n' "$unexpected_github" >&2
    fail "unexpected github reference outside the allowed SQLite migration context"
  fi
fi

printf 'PASS: canonical docs sweep is empty for %s\n' "$DOC"
