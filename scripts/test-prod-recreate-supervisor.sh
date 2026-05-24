#!/usr/bin/env bash
# Focused test for scripts/prod-recreate-supervisor.sh.
#
# This test must verify:
#   (1) The script contains and/or exercises the upstream fetch and
#       update-ref behaviour described in the supervisor design.
#   (2) The script rejects checkout-master / reset-hard usage. The latter is
#       statically rejected by grepping the source (comment lines stripped so
#       the script's own documentation of forbidden commands does not
#       false-positive).
#   (3) The script's recreate enqueue command shape matches the headless CLI
#       contract (`recreate <workflowId>` via headless_mutation with --no-track).
#
# To exercise (1) and (3) hermetically we copy the supervisor + headless-lib
# into a temporary repo, drop mock `electron`/`main.js`/`headless-ipc.js`
# transports, and shim `git` via PATH.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/prod-recreate-supervisor.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "FAIL: missing $SCRIPT" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# (1) Static: upstream fetch + update-ref behaviour is present.
# ---------------------------------------------------------------------------

if ! grep -qE 'git fetch[^\n]*refs/heads/master:refs/remotes/[^[:space:]]*/master' "$SCRIPT"; then
  echo "FAIL: supervisor missing 'git fetch <remote> refs/heads/master:refs/remotes/<remote>/master'" >&2
  exit 1
fi

if ! grep -qE 'git rev-parse [^\n]*refs/remotes/[^[:space:]]*/master' "$SCRIPT"; then
  echo "FAIL: supervisor must resolve refs/remotes/<remote>/master with git rev-parse" >&2
  exit 1
fi

if ! grep -qE 'git update-ref[[:space:]]+refs/heads/master' "$SCRIPT"; then
  echo "FAIL: supervisor must update refs/heads/master with git update-ref" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# (2) Static: checkout master / reset --hard / repo-pool mutation are rejected.
# ---------------------------------------------------------------------------

NONCOMMENT_FILE="$(mktemp -t prod-supervisor-noncomment.XXXXXX)"
sed -E '/^[[:space:]]*#/d' "$SCRIPT" > "$NONCOMMENT_FILE"

if grep -nE 'git[[:space:]]+checkout[[:space:]]+master' "$NONCOMMENT_FILE"; then
  echo "FAIL: supervisor must not run 'git checkout master'" >&2
  exit 1
fi

if grep -nE 'git[[:space:]]+reset[[:space:]]+--hard' "$NONCOMMENT_FILE"; then
  echo "FAIL: supervisor must not run 'git reset --hard'" >&2
  exit 1
fi

if grep -nE '(repo-pool|repo_pool)[^#]*(mv|rm|reset|update-ref|write|fetch|checkout)' "$NONCOMMENT_FILE"; then
  echo "FAIL: supervisor must not mutate repo-pool mirrors" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# (3) Runtime: exercise the script with mocked git + headless transports.
# ---------------------------------------------------------------------------

TMP_DIR="$(mktemp -d -t prod-supervisor-test.XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR" "$NONCOMMENT_FILE"
}
trap cleanup EXIT

FAKE_REPO="$TMP_DIR/repo"
BIN_DIR="$TMP_DIR/bin"
LOG_DIR="$TMP_DIR/logs"
STATE_DIR="$TMP_DIR/state"
mkdir -p "$FAKE_REPO/scripts" "$FAKE_REPO/packages/app/dist" "$BIN_DIR" "$LOG_DIR" "$STATE_DIR"

cp "$SCRIPT" "$FAKE_REPO/scripts/prod-recreate-supervisor.sh"
cp "$ROOT/scripts/headless-lib.sh" "$FAKE_REPO/scripts/headless-lib.sh"
chmod +x "$FAKE_REPO/scripts/prod-recreate-supervisor.sh"

GIT_LOG="$LOG_DIR/git.log"
MUTATION_LOG="$LOG_DIR/mutation.log"
QUERY_LOG="$LOG_DIR/query.log"
CYCLE_FILE="$STATE_DIR/cycle"
echo 0 > "$CYCLE_FILE"

# Stub `git` on PATH. The supervisor only needs fetch / rev-parse / update-ref.
cat > "$BIN_DIR/git" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$GIT_LOG"
case "\${1:-}" in
  fetch) exit 0 ;;
  rev-parse) echo "deadbeefcafef00d1234567890abcdef0badc0de"; exit 0 ;;
  update-ref) exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$BIN_DIR/git"

# Mock the headless-ipc helper used by headless_mutation.
IPC_HELPER="$BIN_DIR/headless-ipc.js"
cat > "$IPC_HELPER" <<EOF
#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync('$MUTATION_LOG', process.argv.slice(2).join(' ') + '\\n');
process.exit(0);
EOF
chmod +x "$IPC_HELPER"

# Mock the Electron transport that headless_query invokes. headless-lib.sh
# calls it as: "\$ELECTRON" "\$MAIN" \$SANDBOX_FLAG --headless "\$@"
# We strip the first arg (main.js path), the --headless flag, and emit a
# cycle-specific workflows.json: cycle 0 returns 1 failed + 1 running, every
# later cycle returns the same shape so the stall path also fires.
cat > "$FAKE_REPO/scripts/electron.cjs" <<EOF
#!/usr/bin/env bash
shift # drop main.js path
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --headless|--no-sandbox) shift ;;
    *) break ;;
  esac
done
echo "\$@" >> "$QUERY_LOG"
cycle="\$(cat "$CYCLE_FILE")"
next=\$((cycle + 1))
echo "\$next" > "$CYCLE_FILE"
cat <<'JSON'
[
  {"id":"wf-1000-1","status":"failed"},
  {"id":"wf-1000-2","status":"running"}
]
JSON
EOF
chmod +x "$FAKE_REPO/scripts/electron.cjs"

# packages/app/dist/main.js can be anything — it's passed as an argv to our
# Electron stub which discards it. Touch it so the path exists.
: > "$FAKE_REPO/packages/app/dist/main.js"

set +e
OUT="$(
  PATH="$BIN_DIR:$PATH" \
  INVOKER_HEADLESS_IPC_HELPER="$IPC_HELPER" \
  PROD_SUPERVISOR_INTERVAL_SECONDS=0 \
  PROD_SUPERVISOR_MAX_CYCLES=2 \
  PROD_SUPERVISOR_STALL_CYCLES=1 \
  bash "$FAKE_REPO/scripts/prod-recreate-supervisor.sh" 2>&1
)"
EC=$?
set -e

if [[ "$EC" -ne 0 ]]; then
  echo "FAIL: supervisor exited with status $EC"
  echo "----- output -----"
  echo "$OUT"
  echo "----- git log -----"
  [[ -f "$GIT_LOG" ]] && cat "$GIT_LOG"
  echo "----- mutation log -----"
  [[ -f "$MUTATION_LOG" ]] && cat "$MUTATION_LOG"
  exit 1
fi

# ---- assertions on git invocations ----
if [[ ! -s "$GIT_LOG" ]]; then
  echo "FAIL: supervisor did not invoke git at all"
  echo "$OUT"
  exit 1
fi

if ! grep -qE '^fetch upstream refs/heads/master:refs/remotes/upstream/master$' "$GIT_LOG"; then
  echo "FAIL: supervisor did not issue the expected upstream fetch"
  echo "----- git log -----"
  cat "$GIT_LOG"
  exit 1
fi

if ! grep -qE '^rev-parse refs/remotes/upstream/master$' "$GIT_LOG"; then
  echo "FAIL: supervisor did not resolve refs/remotes/upstream/master"
  echo "----- git log -----"
  cat "$GIT_LOG"
  exit 1
fi

if ! grep -qE '^update-ref refs/heads/master deadbeefcafef00d1234567890abcdef0badc0de$' "$GIT_LOG"; then
  echo "FAIL: supervisor did not update refs/heads/master to the resolved upstream SHA"
  echo "----- git log -----"
  cat "$GIT_LOG"
  exit 1
fi

if grep -qE '(^| )checkout( |$)' "$GIT_LOG"; then
  echo "FAIL: supervisor invoked git checkout"
  cat "$GIT_LOG"
  exit 1
fi

if grep -qE 'reset --hard' "$GIT_LOG"; then
  echo "FAIL: supervisor invoked git reset --hard"
  cat "$GIT_LOG"
  exit 1
fi

# ---- assertions on recreate enqueue command shape ----
if [[ ! -s "$MUTATION_LOG" ]]; then
  echo "FAIL: supervisor did not enqueue any recreate mutations"
  echo "$OUT"
  exit 1
fi

# Expected shape: `exec -- --no-track recreate <wf-id>`.
if ! grep -qE '^exec -- --no-track recreate wf-1000-1$' "$MUTATION_LOG"; then
  echo "FAIL: supervisor did not enqueue 'recreate wf-1000-1' with --no-track"
  echo "----- mutation log -----"
  cat "$MUTATION_LOG"
  exit 1
fi

# Stall path: with STALL_CYCLES=1 and the failed+running workflows persisting,
# the supervisor must additionally recreate the running workflow under the
# stall branch.
if ! grep -qE '^exec -- --no-track recreate wf-1000-2$' "$MUTATION_LOG"; then
  echo "FAIL: supervisor did not recreate the incomplete (running) workflow after stall threshold"
  echo "----- mutation log -----"
  cat "$MUTATION_LOG"
  exit 1
fi

echo "PASS: prod-recreate-supervisor enforces upstream fetch + update-ref, rejects checkout/reset-hard, and emits expected recreate enqueue shape"
