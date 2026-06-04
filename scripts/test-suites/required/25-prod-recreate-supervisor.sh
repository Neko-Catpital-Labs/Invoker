#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SUPERVISOR="$ROOT/scripts/prod-recreate-supervisor.sh"

[[ -x "$SUPERVISOR" ]] || { echo "FAIL: $SUPERVISOR is not executable" >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

STATE_DIR="$TMP_DIR/.state"
BIN_DIR="$TMP_DIR/bin"
mkdir -p "$TMP_DIR/scripts" "$TMP_DIR/packages/app/dist" "$STATE_DIR" "$BIN_DIR"

cp "$ROOT/scripts/prod-recreate-supervisor.sh" "$TMP_DIR/scripts/prod-recreate-supervisor.sh"
cp "$ROOT/scripts/headless-lib.sh" "$TMP_DIR/scripts/headless-lib.sh"
chmod +x "$TMP_DIR/scripts/prod-recreate-supervisor.sh"

cat > "$STATE_DIR/workflows.json" <<'EOF'
[
  {"id":"wf-100-1","status":"failed"},
  {"id":"wf-200-1","status":"running"},
  {"id":"wf-300-1","status":"completed"}
]
EOF

cat > "$BIN_DIR/git" <<EOF
#!/usr/bin/env bash
set -euo pipefail
GIT_LOG="$STATE_DIR/git.log"
EOF
cat >> "$BIN_DIR/git" <<'EOF'
if [[ "${1:-}" == "-C" ]]; then
  shift 2
fi
printf '%s\n' "$*" >> "$GIT_LOG"
case "${1:-}" in
  fetch)
    exit 0
    ;;
  rev-parse)
    echo "1111111111111111111111111111111111111111"
    exit 0
    ;;
  update-ref)
    exit 0
    ;;
  checkout|reset)
    echo "FORBIDDEN: supervisor must not run git ${1:-}" >&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "$BIN_DIR/git"

cat > "$TMP_DIR/scripts/electron.cjs" <<EOF
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="$STATE_DIR"
EOF
cat >> "$TMP_DIR/scripts/electron.cjs" <<'EOF'
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
: > "$TMP_DIR/packages/app/dist/main.js"

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

GIT_LOG="$STATE_DIR/git.log"
RECREATED_LOG="$STATE_DIR/recreated.log"

fail() {
  echo "FAIL: $1" >&2
  echo "--- git.log ---" >&2; cat "$GIT_LOG" 2>/dev/null >&2 || true
  echo "--- recreated.log ---" >&2; cat "$RECREATED_LOG" 2>/dev/null >&2 || true
  echo "--- supervisor.log ---" >&2; cat "$SUPERVISOR_LOG" >&2
  exit 1
}

[[ "$status" -eq 0 ]] || fail "supervisor exited $status"

grep -qF "fetch upstream refs/heads/master:refs/remotes/upstream/master" "$GIT_LOG" \
  || fail "did not fetch upstream refs/heads/master:refs/remotes/upstream/master"

grep -qE "^update-ref refs/heads/master " "$GIT_LOG" \
  || fail "did not update refs/heads/master via git update-ref"

if grep -qE "^(checkout|reset)\b" "$GIT_LOG"; then
  fail "supervisor ran a forbidden git checkout/reset"
fi

grep -qF "wf-100-1" "$RECREATED_LOG" || fail "failed workflow wf-100-1 was not recreated"
grep -qF "wf-200-1" "$RECREATED_LOG" || fail "stalled incomplete workflow wf-200-1 was not recreated"
if grep -qF "wf-300-1" "$RECREATED_LOG"; then
  fail "completed workflow wf-300-1 must not be recreated"
fi
grep -qF "Stall detected" "$SUPERVISOR_LOG" || fail "stall detection did not trigger"

echo "PASS: prod-recreate-supervisor syncs master via fetch+update-ref and never checkouts/resets master"
