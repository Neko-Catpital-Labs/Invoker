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

expect_no_unexpected_hits() {
  local label="$1"
  local pattern="$2"
  shift 2
  local hits
  local unexpected
  local line
  local allowed_pattern
  local allowed
  hits="$(rg -n --hidden -e "$pattern" "${paths[@]}" || true)"
  if [[ -n "$hits" ]]; then
    unexpected=""
    while IFS= read -r line; do
      allowed=false
      for allowed_pattern in "$@"; do
        if [[ "$line" == $allowed_pattern ]]; then
          allowed=true
          break
        fi
      done
      if [[ "$allowed" == false ]]; then
        unexpected+="${line}"$'\n'
      fi
    done <<< "$hits"
    if [[ -n "$unexpected" ]]; then
      printf '%s' "$unexpected" >&2
      fail "unexpected hits for ${label}"
    fi
  fi
}

expect_no_unexpected_hits "removed merge-mode alias" 'set-merge-mode' \
  "packages/app/src/__tests__/headless-client.test.ts:*expect(output).not.toContain('set-merge-mode')*" \
  "packages/app/src/__tests__/headless-client.test.ts:*runHeadlessClientCommand*set-merge-mode*" \
  "packages/app/src/__tests__/headless-client.test.ts:*toThrow('Unknown command: set-merge-mode')*" \
  "packages/app/src/headless-command-registry.ts:*return command === 'set-merge-mode';*"
expect_no_unexpected_hits "removed restart surfaces" 'invoker:restart-task|restartTask\(|/api/tasks/.*/restart|/api/workflows/.*/restart' \
  "packages/app/src/__tests__/api-server.test.ts:*POST /api/tasks/:id/restart*" \
  "packages/app/src/__tests__/api-server.test.ts:*/api/tasks/task-1/restart*" \
  "packages/app/src/__tests__/api-server.test.ts:*POST /api/workflows/:id/restart*" \
  "packages/app/src/__tests__/api-server.test.ts:*/api/workflows/wf-1/restart*" \
  "packages/app/src/__tests__/parity-regression.test.ts:*/api/tasks/task-1/restart*" \
  "packages/app/src/__tests__/parity-regression.test.ts:*/api/workflows/wf-1/restart*"

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

printf 'PASS: repository canonical sweeps are empty except allowed migration and rejection coverage\n'
