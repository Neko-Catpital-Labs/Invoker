#!/usr/bin/env bash
# Repro: deploy-do1.sh's python "find and kill the old owner process" step
# matches and SIGTERMs its OWN ancestor process, aborting the restart
# sequence before it ever reaches `systemctl restart slack-manager.service`.
#
# Root cause:
#   The kill script (scripts/deploy-do1.sh, inside the `setsid bash -c '...'`
#   restart block) finds kill targets by checking, for every /proc/<pid>:
#     - realpath(cwd) == repo_root
#     - the search substring appears in cmdline
#   The `setsid bash -c '...'` wrapper that RUNS this whole restart sequence
#   also `cd`s into repo_root, and its own cmdline is the literal script
#   source text -- which necessarily contains the same search substring,
#   since that substring is the pgrep/python match pattern written inline in
#   the script itself. So the kill script matches its own ancestor and kills
#   its own process group mid-sequence (observed live: RESTART_STATUS=143,
#   i.e. SIGTERM, with no "restart"/"is-active" log lines ever emitted).
#
# Separately, the search substring itself ("packages/app/dist/main.js") is
# stale: the real deployed owner process is invoked via invoker-ui's AppImage
# (`invoker-ui ... --headless owner-serve` / `.../Invoker.AppImage ...
# --headless owner-serve`), which never contains that path. So even without
# the self-kill, the script could never find a real target to kill either.
#
# This script proves both problems against the CURRENT (buggy) matching
# logic, and confirms the fix: excluding the caller's own process group from
# the kill candidates, plus matching the real "--headless owner-serve"
# invocation shape.
set -euo pipefail

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-deploy-self-match.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

REPO_ROOT="$TMP/repo_root"
mkdir -p "$REPO_ROOT"

fail() { echo "[repro] FAIL: $1"; exit 1; }

# The exact matcher from deploy-do1.sh today (unfixed): cwd==repo_root and
# the stale "packages/app/dist/main.js" substring, no self-exclusion.
BUGGY_MATCHER='
import os, signal, sys
repo_root = os.path.realpath(sys.argv[1])
process_groups = set()
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    pid = int(name)
    try:
        if os.path.realpath(f"/proc/{pid}/cwd") != repo_root:
            continue
        with open(f"/proc/{pid}/cmdline", "rb") as proc:
            command = proc.read().replace(b"\0", b" ").decode(errors="replace")
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
    if "packages/app/dist/main.js" in command:
        process_groups.add(os.getpgid(pid))
print(",".join(str(g) for g in process_groups))
for pg in process_groups:
    try:
        os.killpg(pg, signal.SIGTERM)
    except ProcessLookupError:
        pass
'

# Fixed matcher: matches the real owner invocation shape and explicitly
# excludes the caller's own process group.
FIXED_MATCHER='
import os, signal, sys
repo_root = os.path.realpath(sys.argv[1])
own_pgid = os.getpgid(os.getpid())
process_groups = set()
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    pid = int(name)
    try:
        if os.path.realpath(f"/proc/{pid}/cwd") != repo_root:
            continue
        with open(f"/proc/{pid}/cmdline", "rb") as proc:
            command = proc.read().replace(b"\0", b" ").decode(errors="replace")
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
    if "--headless owner-serve" not in command:
        continue
    pgid = os.getpgid(pid)
    if pgid == own_pgid:
        continue
    process_groups.add(pgid)
print(",".join(str(g) for g in process_groups))
for pg in process_groups:
    try:
        os.killpg(pg, signal.SIGTERM)
    except ProcessLookupError:
        pass
'

run_case() {
  local matcher="$1" case_name="$2"
  local status_file="$TMP/${case_name}.status"
  local owner_pid_file="$TMP/${case_name}.owner_pid"

  # A fake "old owner" process: separate process group, matches the real
  # invocation shape ("--headless owner-serve"), lives under repo_root.
  # `setsid` gives it its own pgid, same as the real owner process (started
  # independently by slack-manager, not by this restart sequence).
  ( cd "$REPO_ROOT" && OWNER_PID_FILE="$owner_pid_file" exec setsid python3 -c '
import os, time
with open(os.environ["OWNER_PID_FILE"], "w") as f:
    f.write(str(os.getpid()))
time.sleep(30)
' --headless owner-serve >/dev/null 2>&1 & )
  sleep 0.3
  local owner_pid
  owner_pid="$(cat "$owner_pid_file" 2>/dev/null || echo "")"
  [ -n "$owner_pid" ] || fail "fake old-owner process never started for case $case_name"

  # The restart sequence itself: mirrors deploy-do1.sh's
  # `setsid bash -c '<script embedding the matcher as literal source>'`.
  # We embed $matcher literally so its own cmdline contains the same
  # substrings the matcher searches for -- exactly deploy-do1.sh's shape.
  setsid bash -c "
    set -euo pipefail
    cd '$REPO_ROOT'
    python3 - '$REPO_ROOT' <<'PY'
$matcher
PY
    echo survived > '$status_file'
  " >/dev/null 2>&1
  local seq_status=$?

  sleep 0.5
  local owner_alive="dead"
  kill -0 "$owner_pid" 2>/dev/null && owner_alive="alive"
  kill -9 "$owner_pid" 2>/dev/null || true

  if [ -f "$status_file" ]; then
    echo "sequence_survived seq_status=$seq_status old_owner=$owner_alive"
  else
    echo "sequence_self_killed seq_status=$seq_status old_owner=$owner_alive"
  fi
}

echo "[repro] === BUGGY matcher (current deploy-do1.sh logic) ==="
BUGGY_RESULT="$(run_case "$BUGGY_MATCHER" buggy)"
echo "[repro] $BUGGY_RESULT"
echo "$BUGGY_RESULT" | grep -q "sequence_self_killed" \
  || fail "expected the buggy matcher to self-kill its own restart sequence, but it survived"
echo "[repro] confirmed: buggy matcher kills its own ancestor, restart sequence never reaches 'systemctl restart'"
echo "[repro] (and separately: old_owner stayed alive -- the stale pattern never matched a real target either)"
echo

echo "[repro] === FIXED matcher (excludes own pgid, matches real invocation) ==="
FIXED_RESULT="$(run_case "$FIXED_MATCHER" fixed)"
echo "[repro] $FIXED_RESULT"
echo "$FIXED_RESULT" | grep -q "sequence_survived" \
  || fail "expected the fixed matcher to let its own restart sequence survive, but it was killed"
echo "$FIXED_RESULT" | grep -q "old_owner=dead" \
  || fail "expected the fixed matcher to actually kill the real old-owner target"
echo "[repro] confirmed: fixed matcher leaves its own ancestor alone AND still kills the real old owner"
echo

echo "[repro] PASS: reproduced the self-kill on the buggy matcher and confirmed the fix"
