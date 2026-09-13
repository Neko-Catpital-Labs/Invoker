#!/usr/bin/env bash
# Deterministic, offline fake Codex CLI that reproduces the fix-ci poll-loop
# token blowup: a backgrounded verify command polled every N seconds, where each
# poll resends the whole growing conversation, so cumulative tokens grow
# near-quadratically in turn count.
#
# Separate from scripts/e2e-dry-run/fixtures/codex-marker.sh on purpose: that
# stub is depended on by 29 e2e-dry-run cases and must not change.
#
# Invoked like the real CLI: codex exec --json [--session-id <id>] <prompt>
# Emits newline-delimited JSON to stdout. Makes no network call.
set -eu

SESSION_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id) SESSION_ID="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

[ -n "$SESSION_ID" ] || SESSION_ID="fix-ci-bench-session"

# Every emitted value is a pure function of the environment: no clock, no
# randomness, no repo state. Two runs with the same env produce byte-identical
# stdout, which is what makes this usable as a measurement baseline.
read_int() {
  local raw="$1" fallback="$2"
  case "$raw" in
    '' | *[!0-9]*) printf '%s' "$fallback" ;;
    *) printf '%s' "$raw" ;;
  esac
}

WALLCLOCK_S=$(read_int "${INVOKER_FIX_CI_BENCH_WALLCLOCK_S:-}" 60)
POLL_INTERVAL_S=$(read_int "${INVOKER_FIX_CI_BENCH_POLL_INTERVAL_S:-}" 10)
MAX_TURNS=$(read_int "${INVOKER_FIX_CI_BENCH_MAX_TURNS:-}" 0)
NEVER_COMPLETES="${INVOKER_FIX_CI_BENCH_NEVER_COMPLETES:-0}"
BASE_TOKENS=$(read_int "${INVOKER_FIX_CI_BENCH_BASE_TOKENS:-}" 50000)
BYTES_PER_POLL=$(read_int "${INVOKER_FIX_CI_BENCH_BYTES_PER_POLL:-}" 1800)
MAX_CONTEXT_TOKENS=$(read_int "${INVOKER_FIX_CI_BENCH_MAX_CONTEXT_TOKENS:-}" 400000)

# A zero interval would divide by zero below; one poll per second is the
# tightest cadence the loop can express.
[ "$POLL_INTERVAL_S" -gt 0 ] || POLL_INTERVAL_S=1

TURNS=$(( (WALLCLOCK_S + POLL_INTERVAL_S - 1) / POLL_INTERVAL_S ))
if [ "$MAX_TURNS" -gt 0 ] && [ "$TURNS" -gt "$MAX_TURNS" ]; then
  TURNS="$MAX_TURNS"
fi

TS="${INVOKER_FIX_CI_BENCH_TIMESTAMP:-2026-01-01T00:00:00.000Z}"
CWD="$(pwd)"

emit() { printf '%s\n' "$1"; }

emit "{\"type\":\"thread.started\",\"thread_id\":\"${SESSION_ID}\"}"
emit "{\"timestamp\":\"${TS}\",\"type\":\"session_meta\",\"payload\":{\"id\":\"${SESSION_ID}\",\"cwd\":\"${CWD}\"}}"
emit "{\"timestamp\":\"${TS}\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"fix-ci-bench-turn\"}}"
emit "{\"timestamp\":\"${TS}\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Repair the failing CI job in this workspace.\"}}"
emit "{\"timestamp\":\"${TS}\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Starting the verify command in the background, then polling until it finishes.\"}]}}"

cumulative=0
turn=1
while [ "$turn" -le "$TURNS" ]; do
  elapsed=$(( turn * POLL_INTERVAL_S ))

  per_turn=$(( BASE_TOKENS + turn * BYTES_PER_POLL ))
  if [ "$per_turn" -gt "$MAX_CONTEXT_TOKENS" ]; then
    per_turn="$MAX_CONTEXT_TOKENS"
  fi
  cumulative=$(( cumulative + per_turn ))

  args="{\\\"poll\\\":${turn},\\\"elapsed_s\\\":${elapsed},\\\"seconds\\\":${POLL_INTERVAL_S},\\\"command\\\":\\\"tail -n 40 verify.log\\\"}"
  emit "{\"timestamp\":\"${TS}\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"wait\",\"call_id\":\"call_${turn}\",\"arguments\":\"${args}\"}}"
  emit "{\"timestamp\":\"${TS}\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_${turn}\",\"output\":\"verify still running after ${elapsed}s (poll ${turn} of ${TURNS})\"}}"
  emit "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"total_tokens\": ${cumulative}}}}}"

  turn=$(( turn + 1 ))
done

if [ "$NEVER_COMPLETES" = "1" ]; then
  exit 0
fi

emit "{\"timestamp\":\"${TS}\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Verify finished. The CI job is repaired.\"}]}}"
emit "{\"timestamp\":\"${TS}\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}"

exit 0
