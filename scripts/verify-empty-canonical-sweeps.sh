#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'verify-empty-canonical-sweeps: %s\n' "$1" >&2
  exit 1
}

if ! command -v rg >/dev/null 2>&1; then
  fail "rg is required"
fi

paths=(.)
source_globs=(
  --glob '!**/__tests__/**'
  --glob '!**/*.test.ts'
  --glob '!**/*.spec.ts'
  --glob '!scripts/verify-empty-canonical-sweeps.sh'
  --glob '!skills/*/fixtures/**'
)

rg_source_hits() {
  local pattern="$1"
  local status=0
  local hits
  hits="$(rg -n --hidden "${source_globs[@]}" -e "$pattern" "${paths[@]}")" || status=$?
  if (( status > 1 )); then
    fail "rg failed with exit status ${status}"
  fi
  printf '%s' "$hits" | sed 's#^\./##'
}

expect_empty() {
  local label="$1"
  local pattern="$2"
  local hits
  hits="$(rg_source_hits "$pattern")"
  if [[ -n "$hits" ]]; then
    printf '%s\n' "$hits" >&2
    fail "unexpected hits for ${label}"
  fi
}

merge_mode_alias_hits="$(rg_source_hits 'set-merge-mode')"
if [[ -n "$merge_mode_alias_hits" ]]; then
  unexpected=""
  while IFS= read -r line; do
    if [[ "$line" == packages/app/src/headless-command-registry.ts:* && "$line" == *"return command === 'set-merge-mode';"* ]]; then
      continue
    fi
    unexpected+="${line}"$'\n'
  done <<< "$merge_mode_alias_hits"
  if [[ -n "$unexpected" ]]; then
    printf '%s\n' "$merge_mode_alias_hits" >&2
    fail "unexpected hits for removed merge-mode alias"
  fi
fi

expect_empty "removed restart surfaces" 'invoker:restart-task|restartTask\(|/api/tasks/.*/restart|/api/workflows/.*/restart'

compat_hits="$(
  rg_source_hits "github \\| external_review|merge_mode = 'github'|Use /api/.*/restart"
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

printf 'PASS: repository canonical sweeps found only allowed compatibility guards\n'
