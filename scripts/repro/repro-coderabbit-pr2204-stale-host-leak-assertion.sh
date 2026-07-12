#!/usr/bin/env bash
# Repro for CodeRabbit PR #2204 finding:
#   packages/app/src/__tests__/open-terminal.test.ts — the "all four refreshed
#   coordinates" terminal-restore test declares the invariant "None may be the
#   stale persisted ones", yet it only asserts the stale KEY and stale PORT are
#   excluded. It never guards the stale HOST. A stale host leaking into the
#   spawned terminal args ALONGSIDE the refreshed host (i.e. connecting the
#   operator to the previous machine) would sail past this test undetected.
#
# This repro (a) demonstrates the existing assertions cannot see a stale-host
# leak, and (b) fails until the regression test explicitly excludes the stale
# persisted host. Exits NON-ZERO on the buggy (unguarded) state.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_FILE="packages/app/src/__tests__/open-terminal.test.ts"

# Stale persisted coordinates (crabboxPersistence fixture) vs the refreshed
# coordinates the Crabbox `status` call reports. Terminal restore must rebuild
# the SSH endpoint entirely from the refreshed values.
STALE_HOST="10.0.0.1"
STALE_PORT="2222"
STALE_KEY="/home/me/.ssh/old"
FRESH_HOST="203.0.113.9"
FRESH_USER="runner"
FRESH_PORT="2200"
FRESH_KEY="/home/me/.ssh/fresh"

contains() { grep -qF -- "$2" <<<"$1"; }

# ── Part A: prove the gap is real ────────────────────────────────────────────
# Simulate a launch-args payload where the stale host leaked in alongside the
# refreshed host — the exact failure the "no stale coordinate" invariant guards.
leaked_args="[\"-i\",\"${FRESH_KEY}\",\"-p\",\"${FRESH_PORT}\",\"-o\",\"StrictHostKeyChecking=accept-new\",\"-t\",\"${FRESH_USER}@${FRESH_HOST}\",\"--fallback\",\"${FRESH_USER}@${STALE_HOST}\"]"

if ! contains "$leaked_args" "$FRESH_KEY" \
  || ! contains "$leaked_args" "$FRESH_PORT" \
  || ! contains "$leaked_args" "${FRESH_USER}@${FRESH_HOST}"; then
  echo "FAIL: repro setup wrong — leaked payload missing a refreshed coordinate" >&2
  exit 1
fi
if contains "$leaked_args" "$STALE_KEY" || contains "$leaked_args" "$STALE_PORT"; then
  echo "FAIL: repro setup wrong — leaked payload should not carry stale key/port" >&2
  exit 1
fi
if ! contains "$leaked_args" "$STALE_HOST"; then
  echo "FAIL: repro setup wrong — expected stale host present in leaked payload" >&2
  exit 1
fi
echo "Demonstrated: the existing (stale key + stale port) assertions all hold on a payload that still carries the stale host — the leak is invisible to them."

# ── Part B: the regression test must guard the stale host too ────────────────
# Slice out the "all four refreshed coordinates" test body and require that it
# asserts the stale persisted host is excluded from the launch args.
block="$(awk '/rebuilds the SSH endpoint with all four refreshed coordinates/{f=1} f{print} f&&/^  \}\);/{exit}' "$TEST_FILE")"

if [[ -z "$block" ]]; then
  echo "FAIL: could not locate the 'all four refreshed coordinates' test in $TEST_FILE" >&2
  exit 1
fi

if ! grep -qF "not.toContain('${STALE_HOST}')" <<<"$block"; then
  echo "FAIL: ${TEST_FILE} — the 'all four refreshed coordinates' test does not assert the stale host (${STALE_HOST}) is excluded from terminal launch args; a stale-host leak alongside the refreshed host would go undetected." >&2
  exit 1
fi

echo "PASS: the regression test explicitly excludes the stale persisted host (${STALE_HOST}) from terminal launch args."
