#!/usr/bin/env bash
# Contract test for scripts/prod-recreate-supervisor.sh.
#
# Verifies — with mocked git, electron headless query, and headless mutation —
# that the supervisor:
#   1. is executable
#   2. validates integer env knobs
#   3. fetches `upstream refs/heads/master:refs/remotes/upstream/master`
#   4. updates refs/heads/master via `git update-ref` using the rev-parsed sha
#   5. never runs `git checkout master` or `git reset master`
#   6. recreates each failed workflow per cycle
#   7. recreates every incomplete workflow when the incomplete count is stable
#      for STALL_CYCLES consecutive cycles
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SUPERVISOR_SCRIPT="$ROOT/scripts/prod-recreate-supervisor.sh"

if [[ ! -x "$SUPERVISOR_SCRIPT" ]]; then
  echo "FAIL: $SUPERVISOR_SCRIPT must be executable"
  exit 1
fi

# Acceptance criterion: script content fetches the expected refspec and uses
# update-ref on refs/heads/master.
if ! grep -q 'git fetch "\$UPSTREAM_REMOTE" refs/heads/master:refs/remotes/upstream/master' "$SUPERVISOR_SCRIPT"; then
  echo "FAIL: supervisor must fetch upstream refs/heads/master:refs/remotes/upstream/master"
  exit 1
fi
if ! grep -q 'git update-ref refs/heads/master' "$SUPERVISOR_SCRIPT"; then
  echo "FAIL: supervisor must update refs/heads/master via git update-ref"
  exit 1
fi
# Exclude comment lines so the documentation in the script header (which
# explicitly states it does NOT do `git checkout master` / `git reset master`)
# does not trigger a false positive.
if grep -vE '^[[:space:]]*#' "$SUPERVISOR_SCRIPT" \
  | grep -E 'git[[:space:]]+(checkout|reset)[[:space:]]+(--[a-z]+[[:space:]]+)?(refs/heads/)?master\b' \
  >/dev/null; then
  echo "FAIL: supervisor must not checkout or reset master"
  exit 1
fi

TMP_DIR="$(mktemp -d -t prod-supervisor-test.XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p \
  "$TMP_DIR/scripts" \
  "$TMP_DIR/bin" \
  "$TMP_DIR/packages/app/dist"

cp "$SUPERVISOR_SCRIPT" "$TMP_DIR/scripts/prod-recreate-supervisor.sh"
cp "$ROOT/scripts/headless-lib.sh" "$TMP_DIR/scripts/headless-lib.sh"
chmod +x "$TMP_DIR/scripts/prod-recreate-supervisor.sh"

# Placeholder main.js so the headless-lib MAIN path argument exists.
touch "$TMP_DIR/packages/app/dist/main.js"

# Mock electron.cjs — returns the canned workflows JSON for the `query workflows`
# subcommand. Ignores any other invocation.
cat > "$TMP_DIR/scripts/electron.cjs" <<'EOF'
#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('query') && args.includes('workflows')) {
  const fixture = process.env.INVOKER_TEST_WORKFLOWS_JSON_FILE;
  if (fixture && fs.existsSync(fixture)) {
    process.stdout.write(fs.readFileSync(fixture, 'utf-8'));
  } else {
    process.stdout.write('[]');
  }
  process.exit(0);
}
process.exit(0);
EOF
chmod +x "$TMP_DIR/scripts/electron.cjs"

# Mock run.sh — used by headless_mutation in standalone mode. Records every
# mutation invocation (post `--headless`) to the mutation log.
cat > "$TMP_DIR/run.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
LOG="${INVOKER_TEST_MUTATION_LOG:?INVOKER_TEST_MUTATION_LOG required}"
if [[ "${1:-}" != "--headless" ]]; then
  echo "mock run.sh expects --headless" >&2
  exit 1
fi
shift
printf '%s\n' "$*" >> "$LOG"
exit 0
EOF
chmod +x "$TMP_DIR/run.sh"

# Mock git — records each invocation and returns canned values for the few
# subcommands the supervisor uses.
cat > "$TMP_DIR/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
LOG="${INVOKER_TEST_GIT_LOG:?INVOKER_TEST_GIT_LOG required}"
printf '%s\n' "$*" >> "$LOG"
case "${1:-}" in
  fetch)
    exit 0
    ;;
  rev-parse)
    echo "deadbeefcafebabe1234567890abcdefdeadbeef"
    exit 0
    ;;
  update-ref)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "$TMP_DIR/bin/git"

# Workflow fixture: 1 failed, 2 running/pending (incomplete), 1 completed.
# Incomplete count is stable at 3 across cycles (the count includes the failed
# workflow), which lets us exercise STALL_CYCLES.
cat > "$TMP_DIR/workflows.json" <<'EOF'
[
  {"id": "wf-100-1", "status": "failed"},
  {"id": "wf-100-2", "status": "running"},
  {"id": "wf-100-3", "status": "pending"},
  {"id": "wf-100-4", "status": "completed"}
]
EOF

# -----------------------------------------------------------------------------
# Sub-test 1: integer validation rejects non-integer INTERVAL_SECONDS.
# -----------------------------------------------------------------------------
set +e
INTERVAL_SECONDS=nope MAX_CYCLES=1 STALL_CYCLES=1 \
  bash "$TMP_DIR/scripts/prod-recreate-supervisor.sh" \
  > "$TMP_DIR/bad-int.log" 2>&1
BAD_RC=$?
set -e
if [[ "$BAD_RC" -eq 0 ]]; then
  echo "FAIL: supervisor accepted non-integer INTERVAL_SECONDS"
  cat "$TMP_DIR/bad-int.log"
  exit 1
fi
if ! grep -q "INTERVAL_SECONDS=nope" "$TMP_DIR/bad-int.log"; then
  echo "FAIL: supervisor must report invalid INTERVAL_SECONDS"
  cat "$TMP_DIR/bad-int.log"
  exit 1
fi

# -----------------------------------------------------------------------------
# Sub-test 2: 2-cycle run with stall threshold of 1. Verifies the git contract,
# per-cycle failed recreate, and the all-incomplete recreate when stalled.
# -----------------------------------------------------------------------------
GIT_LOG="$TMP_DIR/git.log"
MUT_LOG="$TMP_DIR/mutation.log"
: > "$GIT_LOG"
: > "$MUT_LOG"

PATH="$TMP_DIR/bin:$PATH" \
INVOKER_HEADLESS_STANDALONE=1 \
INVOKER_TEST_WORKFLOWS_JSON_FILE="$TMP_DIR/workflows.json" \
INVOKER_TEST_GIT_LOG="$GIT_LOG" \
INVOKER_TEST_MUTATION_LOG="$MUT_LOG" \
INTERVAL_SECONDS=1 \
MAX_CYCLES=2 \
STALL_CYCLES=1 \
UPSTREAM_REMOTE=upstream \
  bash "$TMP_DIR/scripts/prod-recreate-supervisor.sh" \
  > "$TMP_DIR/run.log" 2>&1

# Git contract checks.
if ! grep -Fxq "fetch upstream refs/heads/master:refs/remotes/upstream/master" "$GIT_LOG"; then
  echo "FAIL: expected 'git fetch upstream refs/heads/master:refs/remotes/upstream/master'"
  echo "--- git.log ---"
  cat "$GIT_LOG"
  echo "--- run.log ---"
  cat "$TMP_DIR/run.log"
  exit 1
fi
if ! grep -Fxq "rev-parse refs/remotes/upstream/master" "$GIT_LOG"; then
  echo "FAIL: expected 'git rev-parse refs/remotes/upstream/master'"
  cat "$GIT_LOG"
  exit 1
fi
if ! grep -Fq "update-ref refs/heads/master deadbeefcafebabe1234567890abcdefdeadbeef" "$GIT_LOG"; then
  echo "FAIL: expected 'git update-ref refs/heads/master <sha>' using the rev-parsed sha"
  cat "$GIT_LOG"
  exit 1
fi
if grep -E '^(checkout|reset)[[:space:]]' "$GIT_LOG" | grep -E '(refs/heads/)?master' >/dev/null; then
  echo "FAIL: supervisor must not checkout/reset master"
  cat "$GIT_LOG"
  exit 1
fi

# Two cycles → two fetches and two update-refs.
FETCH_COUNT="$(grep -c '^fetch upstream refs/heads/master:refs/remotes/upstream/master$' "$GIT_LOG" || true)"
UPDATE_COUNT="$(grep -c '^update-ref refs/heads/master ' "$GIT_LOG" || true)"
if [[ "$FETCH_COUNT" -ne 2 ]]; then
  echo "FAIL: expected 2 fetches across 2 cycles, got $FETCH_COUNT"
  cat "$GIT_LOG"
  exit 1
fi
if [[ "$UPDATE_COUNT" -ne 2 ]]; then
  echo "FAIL: expected 2 update-refs across 2 cycles, got $UPDATE_COUNT"
  cat "$GIT_LOG"
  exit 1
fi

# Failed workflow recreated each cycle.
FAILED_RECREATE_COUNT="$(grep -c '^--no-track recreate wf-100-1$' "$MUT_LOG" || true)"
if [[ "$FAILED_RECREATE_COUNT" -lt 2 ]]; then
  echo "FAIL: expected at least 2 recreates of failed wf-100-1, got $FAILED_RECREATE_COUNT"
  cat "$MUT_LOG"
  exit 1
fi

# Stall pass (cycle 2) recreates every incomplete workflow, including the
# non-failed ones. Completed workflow must never be recreated.
if ! grep -Fxq -- "--no-track recreate wf-100-2" "$MUT_LOG"; then
  echo "FAIL: expected stall pass to recreate incomplete wf-100-2"
  cat "$MUT_LOG"
  exit 1
fi
if ! grep -Fxq -- "--no-track recreate wf-100-3" "$MUT_LOG"; then
  echo "FAIL: expected stall pass to recreate incomplete wf-100-3"
  cat "$MUT_LOG"
  exit 1
fi
if grep -Fxq -- "--no-track recreate wf-100-4" "$MUT_LOG"; then
  echo "FAIL: completed wf-100-4 must not be recreated"
  cat "$MUT_LOG"
  exit 1
fi

# -----------------------------------------------------------------------------
# Sub-test 3: stall does not fire when STALL_CYCLES is large.
# -----------------------------------------------------------------------------
: > "$GIT_LOG"
: > "$MUT_LOG"

PATH="$TMP_DIR/bin:$PATH" \
INVOKER_HEADLESS_STANDALONE=1 \
INVOKER_TEST_WORKFLOWS_JSON_FILE="$TMP_DIR/workflows.json" \
INVOKER_TEST_GIT_LOG="$GIT_LOG" \
INVOKER_TEST_MUTATION_LOG="$MUT_LOG" \
INTERVAL_SECONDS=1 \
MAX_CYCLES=1 \
STALL_CYCLES=99 \
UPSTREAM_REMOTE=upstream \
  bash "$TMP_DIR/scripts/prod-recreate-supervisor.sh" \
  > "$TMP_DIR/run.log" 2>&1

# Only the failed workflow should be recreated; running/pending should not.
if grep -Fxq -- "--no-track recreate wf-100-2" "$MUT_LOG"; then
  echo "FAIL: STALL_CYCLES=99 must not trigger recreate of wf-100-2"
  cat "$MUT_LOG"
  exit 1
fi
if grep -Fxq -- "--no-track recreate wf-100-3" "$MUT_LOG"; then
  echo "FAIL: STALL_CYCLES=99 must not trigger recreate of wf-100-3"
  cat "$MUT_LOG"
  exit 1
fi
if ! grep -Fxq -- "--no-track recreate wf-100-1" "$MUT_LOG"; then
  echo "FAIL: failed wf-100-1 must be recreated even without stall"
  cat "$MUT_LOG"
  exit 1
fi

echo "PASS: prod-recreate-supervisor enforces fetch/update-ref master sync, recreates failed workflows, and recreates incomplete workflows on stall"
