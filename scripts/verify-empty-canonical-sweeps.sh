#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'verify-empty-canonical-sweeps: %s\n' "$1" >&2
  exit 1
}

if ! command -v rg >/dev/null 2>&1; then
  fail "rg is required"
fi

paths=(packages docs invoker-ctl)

expect_empty() {
  local label="$1"
  local pattern="$2"
  local hits
  hits="$(rg -n --hidden -e "$pattern" "${paths[@]}" || true)"
  if [[ -n "$hits" ]]; then
    printf '%s\n' "$hits" >&2
    fail "unexpected hits for ${label}"
  fi
}

expect_empty "removed merge-mode alias" 'set-merge-mode'
expect_empty "removed restart surfaces" 'invoker:restart-task|restartTask\(|/api/tasks/.*/restart|/api/workflows/.*/restart'

compat_hits="$(
  rg -n --hidden -e "github \\| external_review|merge_mode = 'github'|Use /api/.*/restart" "${paths[@]}" || true
)"
if [[ -n "$compat_hits" ]]; then
  unexpected=""
  allowed_count=0
  while IFS= read -r line; do
    if [[ "$line" == packages/data-store/src/sqlite-migrations.ts:* && "$line" == *"WHERE merge_mode = 'github'"* ]]; then
      allowed_count=$((allowed_count + 1))
    else
      unexpected+="${line}"$'\n'
    fi
  done <<< "$compat_hits"
  if [[ -n "$unexpected" || "$allowed_count" != "1" ]]; then
    printf '%s\n' "$compat_hits" >&2
    fail "unexpected compatibility-label hits"
  fi
fi

printf 'PASS: repository canonical sweeps are empty except the allowed SQLite migration\n'
