#!/usr/bin/env bash
# Dummy Codex CLI for e2e-dry-run: no network, instant exit 0.
# Outputs JSONL to stdout (simulates codex exec --json).
# Invoked like: codex exec --json [--full-auto] <prompt>
set -eu

# Parse --session-id if provided, otherwise generate one.
SESSION_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id) SESSION_ID="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$SESSION_ID" ]; then
  SESSION_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null || echo 'e2e-stub-session-id')"
fi

ROOT="${INVOKER_E2E_MARKER_ROOT:-}"
if [ -n "$ROOT" ]; then
  mkdir -p "$ROOT"
  ts="$(date +%s)"
  echo ok >"$ROOT/codex-${ts}-$$.marker"
fi

# Output JSONL to stdout (simulates codex exec --json)
TS_ISO=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
CWD="$(pwd)"
# Emit thread.started first (matches real Codex CLI v0.117+ behavior)
printf '%s\n' "{\"type\":\"thread.started\",\"thread_id\":\"${SESSION_ID}\"}"
printf '%s\n' "{\"timestamp\":\"${TS_ISO}\",\"type\":\"session_meta\",\"payload\":{\"id\":\"${SESSION_ID}\",\"cwd\":\"${CWD}\"}}"
printf '%s\n' "{\"timestamp\":\"${TS_ISO}\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"e2e-turn\"}}"
printf '%s\n' "{\"timestamp\":\"${TS_ISO}\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Fix the build error in this workspace\"}}"
printf '%s\n' "{\"timestamp\":\"${TS_ISO}\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"I found and fixed the issue. The build should pass now.\"}]}}"
printf '%s\n' "{\"timestamp\":\"${TS_ISO}\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}"

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
