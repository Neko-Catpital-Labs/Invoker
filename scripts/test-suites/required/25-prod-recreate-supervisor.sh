#!/usr/bin/env bash
# Required contract coverage for scripts/prod-recreate-supervisor.sh.
#
# Builds a hermetic fake repo root with mocked git + headless owner so the
# supervisor's behavior can be asserted without touching real git refs or the
# real engine. Verifies:
#   - the supervisor script is executable
#   - master is synced via `git fetch upstream refs/heads/master:refs/remotes/upstream/master`
#   - refs/heads/master is updated via `git update-ref` (never checkout/reset)
#   - failed workflows are recreated through headless owner delegation
#   - a stalled (unchanged) incomplete count triggers recreate of every
#     incomplete workflow after STALL_CYCLES
#   - completed/closed (terminal) workflows are never recreated
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

SUPERVISOR="$ROOT/scripts/prod-recreate-supervisor.sh"
[[ -x "$SUPERVISOR" ]] || { echo "FAIL: $SUPERVISOR is not executable" >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

STATE_DIR="$TMP_DIR/.state"
BIN_DIR="$TMP_DIR/bin"
mkdir -p "$TMP_DIR/scripts" "$TMP_DIR/packages/app/dist" "$STATE_DIR" "$BIN_DIR"

# Copy the script under test and its required library into the fake repo root
# so REPO_ROOT (derived from headless-lib.sh) resolves to $TMP_DIR.
cp "$ROOT/scripts/prod-recreate-supervisor.sh" "$TMP_DIR/scripts/prod-recreate-supervisor.sh"
cp "$ROOT/scripts/headless-lib.sh" "$TMP_DIR/scripts/headless-lib.sh"
chmod +x "$TMP_DIR/scripts/prod-recreate-supervisor.sh"

# ---------------------------------------------------------------------------
# Workflow fixture: one failed, one running, one completed.
# The counts stay constant across cycles to exercise stall detection.
# ---------------------------------------------------------------------------
cat > "$STATE_DIR/workflows.json" <<'EOF'
[
  {"id":"wf-100-1","status":"failed"},
  {"id":"wf-200-1","status":"running"},
  {"id":"wf-300-1","status":"completed"}
]
EOF

# ---------------------------------------------------------------------------
# Mock git: records every invocation and refuses checkout/reset of master.
# ---------------------------------------------------------------------------
cat > "$BIN_DIR/git" <<EOF
#!/usr/bin/env bash
set -euo pipefail
GIT_LOG="$STATE_DIR/git.log"
EOF
cat >> "$BIN_DIR/git" <<'EOF'
# Drop a leading "-C <dir>" so we can dispatch on the real subcommand.
if [[ "${1:-}" == "-C" ]]; then
  shift 2
fi
printf '%s\n' "$*" >> "$GIT_LOG"
sub="${1:-}"
case "$sub" in
  fetch)
    exit 0
    ;;
  rev-parse)
    # Resolve the upstream tracking ref to a deterministic fake sha.
    echo "1111111111111111111111111111111111111111"
    exit 0
    ;;
  update-ref)
    exit 0
    ;;
  checkout|reset)
    echo "FORBIDDEN: supervisor must not run 'git $sub' on master" >&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "$BIN_DIR/git"

# ---------------------------------------------------------------------------
# Mock headless owner read path: scripts/electron.cjs is invoked by
# headless_query as `electron.cjs <MAIN> [--no-sandbox] --headless <args...>`.
# ---------------------------------------------------------------------------
cat > "$TMP_DIR/scripts/electron.cjs" <<EOF
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="$STATE_DIR"
EOF
cat >> "$TMP_DIR/scripts/electron.cjs" <<'EOF'
# If this is a `query workflows` call, emit the fixture JSON.
have_query=0
have_workflows=0
for arg in "$@"; do
  [[ "$arg" == "query" ]] && have_query=1
  [[ "$arg" == "workflows" ]] && have_workflows=1
done
if [[ "$have_query" == 1 && "$have_workflows" == 1 ]]; then
  cat "$STATE_DIR/workflows.json"
fi
exit 0
EOF
chmod +x "$TMP_DIR/scripts/electron.cjs"
# headless-lib.sh references this path but the mock electron ignores it.
: > "$TMP_DIR/packages/app/dist/main.js"

# ---------------------------------------------------------------------------
# Mock headless owner mutation path: standalone mode routes recreate through
# run.sh as `run.sh --headless recreate <workflowId>`.
# ---------------------------------------------------------------------------
cat > "$TMP_DIR/run.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="$STATE_DIR"
EOF
cat >> "$TMP_DIR/run.sh" <<'EOF'
if [[ "${1:-}" != "--headless" ]]; then
  echo "mock run.sh expects --headless" >&2
  exit 1
fi
shift
if [[ "${1:-}" == "recreate" ]]; then
  printf '%s\n' "${2:-}" >> "$STATE_DIR/recreated.log"
  echo "queued recreate ${2:-}"
  exit 0
fi
echo "unsupported headless command: ${1:-}" >&2
exit 1
EOF
chmod +x "$TMP_DIR/run.sh"

# ---------------------------------------------------------------------------
# Run the supervisor: 3 bounded cycles, stall after 2 unchanged cycles.
# Standalone mode routes mutations through the mock run.sh.
# ---------------------------------------------------------------------------
SUPERVISOR_LOG="$TMP_DIR/supervisor.log"
set +e
PATH="$BIN_DIR:$PATH" \
INVOKER_HEADLESS_STANDALONE=1 \
INTERVAL_SECONDS=1 \
MAX_CYCLES=3 \
STALL_CYCLES=2 \
UPSTREAM_REMOTE=upstream \
  bash "$TMP_DIR/scripts/prod-recreate-supervisor.sh" >"$SUPERVISOR_LOG" 2>&1
status=$?
set -e

if [[ "$status" -ne 0 ]]; then
  echo "FAIL: supervisor exited $status" >&2
  cat "$SUPERVISOR_LOG" >&2
  exit 1
fi

GIT_LOG="$STATE_DIR/git.log"
RECREATED_LOG="$STATE_DIR/recreated.log"

fail() {
  echo "FAIL: $1" >&2
  echo "--- git.log ---" >&2; cat "$GIT_LOG" 2>/dev/null >&2 || true
  echo "--- recreated.log ---" >&2; cat "$RECREATED_LOG" 2>/dev/null >&2 || true
  echo "--- supervisor.log ---" >&2; cat "$SUPERVISOR_LOG" >&2
  exit 1
}

# 1. Master synced via the exact upstream fetch refspec.
grep -qF "fetch upstream refs/heads/master:refs/remotes/upstream/master" "$GIT_LOG" \
  || fail "did not fetch upstream refs/heads/master:refs/remotes/upstream/master"

# 2. Master pointer advanced via git update-ref (no checkout/reset).
grep -qE "^update-ref refs/heads/master " "$GIT_LOG" \
  || fail "did not update refs/heads/master via git update-ref"

# 3. The supervisor must never checkout or reset master.
if grep -qE "^(checkout|reset)\b" "$GIT_LOG"; then
  fail "supervisor ran a forbidden git checkout/reset"
fi

# 4. The failed workflow was recreated through headless delegation.
grep -qF "wf-100-1" "$RECREATED_LOG" || fail "failed workflow wf-100-1 was not recreated"

# 5. Stall recreate swept the still-incomplete (running) workflow too.
grep -qF "wf-200-1" "$RECREATED_LOG" || fail "stalled incomplete workflow wf-200-1 was not recreated"

# 6. Terminal (completed) workflows are never recreated.
if grep -qF "wf-300-1" "$RECREATED_LOG"; then
  fail "completed workflow wf-300-1 must not be recreated"
fi

# 7. Stall log line proves the unchanged-count path fired.
grep -qF "Stall detected" "$SUPERVISOR_LOG" || fail "stall detection did not trigger"

echo "PASS: prod-recreate-supervisor syncs master via fetch+update-ref, recreates failed and stalled-incomplete workflows, and never checkouts/resets master"
