#!/usr/bin/env bash
# Focused coverage for scripts/prod-recreate-supervisor.sh.
#
# Proves three things:
#   1. The script contains the expected `git fetch upstream` /
#      `git update-ref refs/heads/master` lines and is missing the
#      forbidden checkout/reset-hard/repo-pool mutations.
#   2. A single cycle, when wired against mocked git + run.sh, actually
#      invokes fetch + update-ref with the right argument shape.
#   3. A single cycle queues a `recreate <wf_id>` mutation per failed
#      workflow (and only for failed workflows when no stall is detected).
#      A multi-cycle stall scenario triggers `recreate` for every incomplete
#      workflow once STALL_CYCLES is reached.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/prod-recreate-supervisor.sh"
HEADLESS_LIB="$ROOT/scripts/headless-lib.sh"

[[ -f "$SCRIPT" ]] || { echo "FAIL: missing $SCRIPT"; exit 1; }
[[ -x "$SCRIPT" ]] || { echo "FAIL: $SCRIPT is not executable"; exit 1; }
[[ -f "$HEADLESS_LIB" ]] || { echo "FAIL: missing $HEADLESS_LIB"; exit 1; }

# ---------------------------------------------------------------------------
# Phase A — static content checks.
# ---------------------------------------------------------------------------

# Required commands (positive checks).
grep -qE 'git[^#]*fetch[^#]*upstream[^#]*refs/heads/master:refs/remotes/upstream/master' "$SCRIPT" \
  || { echo "FAIL: missing 'git fetch upstream refs/heads/master:refs/remotes/upstream/master'"; exit 1; }

grep -qE 'git[^#]*rev-parse[^#]*refs/remotes/upstream/master' "$SCRIPT" \
  || { echo "FAIL: missing 'git rev-parse refs/remotes/upstream/master'"; exit 1; }

grep -qE 'git[^#]*update-ref[^#]*refs/heads/master' "$SCRIPT" \
  || { echo "FAIL: missing 'git update-ref refs/heads/master'"; exit 1; }

# Required env knobs.
for var in INTERVAL_SECONDS MAX_CYCLES STALL_CYCLES; do
  grep -qE "${var}:-" "$SCRIPT" \
    || { echo "FAIL: missing env knob ${var}"; exit 1; }
done

# Forbidden mutations (negative checks). Strip comments so the *script behaviour*
# is what we check, not the explanatory header.
CODE_ONLY="$(sed -E 's/[[:space:]]*#.*$//' "$SCRIPT")"
if grep -qE 'git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?checkout[[:space:]]+master' <<<"$CODE_ONLY"; then
  echo "FAIL: forbidden 'git checkout master' present in script body"; exit 1
fi
if grep -qE 'reset[[:space:]]+--hard' <<<"$CODE_ONLY"; then
  echo "FAIL: forbidden 'reset --hard' present in script body"; exit 1
fi
if grep -qE 'repo-pool' <<<"$CODE_ONLY"; then
  echo "FAIL: forbidden 'repo-pool' mutation reference present in script body"; exit 1
fi

# ---------------------------------------------------------------------------
# Test harness — copy script + headless-lib into a sandbox repo root with
# mock electron / run.sh / git binaries so behaviour can be observed.
# ---------------------------------------------------------------------------

TMP="$(mktemp -d -t prod-recreate-supervisor-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/scripts" "$TMP/packages/app/dist" "$TMP/state" "$TMP/bin"

cp "$SCRIPT" "$TMP/scripts/prod-recreate-supervisor.sh"
cp "$HEADLESS_LIB" "$TMP/scripts/headless-lib.sh"
chmod +x "$TMP/scripts/prod-recreate-supervisor.sh"

# Mock electron.cjs — only needs to satisfy `query workflows --output json`.
cat > "$TMP/scripts/electron.cjs" <<'NODE'
#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const isHeadless = args.includes('--headless');
const subIdx = args.indexOf('query');
const sub = subIdx >= 0 ? args[subIdx + 1] : '';
if (isHeadless && sub === 'workflows') {
  const fixture = process.env.MOCK_WORKFLOWS_JSON_FILE || '';
  if (fixture && fs.existsSync(fixture)) {
    process.stdout.write(fs.readFileSync(fixture, 'utf8'));
  } else {
    process.stdout.write('[]');
  }
  process.exit(0);
}
process.exit(0);
NODE
chmod +x "$TMP/scripts/electron.cjs"

# Stub main.js so the path exists; the mock electron.cjs ignores its contents.
: > "$TMP/packages/app/dist/main.js"

# Mock run.sh — captures every headless mutation as a single line in the log.
cat > "$TMP/run.sh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
log="${MOCK_MUTATION_LOG:?MOCK_MUTATION_LOG required}"
if [[ "${1:-}" != "--headless" ]]; then
  echo "mock run.sh expected --headless, got: $*" >&2
  exit 1
fi
shift
printf '%s\n' "$*" >> "$log"
BASH
chmod +x "$TMP/run.sh"

# Mock git — record every invocation (sans leading `-C <dir>`) and answer
# `rev-parse refs/remotes/upstream/master` with a deterministic SHA.
cat > "$TMP/bin/git" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
log="${MOCK_GIT_LOG:?MOCK_GIT_LOG required}"
args=("$@")
if [[ "${args[0]:-}" == "-C" ]]; then
  args=("${args[@]:2}")
fi
printf '%s\n' "${args[*]}" >> "$log"
case "${args[*]}" in
  "rev-parse refs/remotes/upstream/master")
    printf '%s\n' "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    ;;
esac
exit 0
BASH
chmod +x "$TMP/bin/git"

# Fixture: 2 failed, 1 running, 1 completed. Incomplete count = 3 (stable).
FIX="$TMP/state/workflows.json"
cat > "$FIX" <<'JSON'
[
  {"id":"wf-1000-1","status":"failed"},
  {"id":"wf-1001-1","status":"failed"},
  {"id":"wf-1002-1","status":"running"},
  {"id":"wf-1003-1","status":"completed"}
]
JSON

run_supervisor() {
  local mutation_log="$1"
  local git_log="$2"
  local max_cycles="$3"
  local stall_cycles="$4"
  : > "$mutation_log"
  : > "$git_log"
  env PATH="$TMP/bin:$PATH" \
    INVOKER_HEADLESS_STANDALONE=1 \
    MOCK_WORKFLOWS_JSON_FILE="$FIX" \
    MOCK_MUTATION_LOG="$mutation_log" \
    MOCK_GIT_LOG="$git_log" \
    INTERVAL_SECONDS=1 \
    MAX_CYCLES="$max_cycles" \
    STALL_CYCLES="$stall_cycles" \
    bash "$TMP/scripts/prod-recreate-supervisor.sh" > "$TMP/state/run.out" 2>&1 \
    || { echo "FAIL: supervisor exited non-zero"; cat "$TMP/state/run.out"; exit 1; }
}

# ---------------------------------------------------------------------------
# Phase B — single cycle: git fetch + update-ref + recreate failed only.
# ---------------------------------------------------------------------------

MUT_LOG="$TMP/state/mutations-1.log"
GIT_LOG="$TMP/state/git-1.log"
run_supervisor "$MUT_LOG" "$GIT_LOG" 1 10

grep -qxF 'fetch upstream refs/heads/master:refs/remotes/upstream/master' "$GIT_LOG" \
  || { echo "FAIL: expected upstream fetch invocation"; echo "--- git log ---"; cat "$GIT_LOG"; exit 1; }

grep -qxF 'rev-parse refs/remotes/upstream/master' "$GIT_LOG" \
  || { echo "FAIL: expected rev-parse of refs/remotes/upstream/master"; cat "$GIT_LOG"; exit 1; }

grep -qxF 'update-ref refs/heads/master deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' "$GIT_LOG" \
  || { echo "FAIL: expected update-ref with resolved SHA"; cat "$GIT_LOG"; exit 1; }

if grep -qE '^(checkout|reset)' "$GIT_LOG"; then
  echo "FAIL: supervisor invoked checkout/reset"; cat "$GIT_LOG"; exit 1
fi

# Failed workflows recreated.
grep -qxF -- '--no-track recreate wf-1000-1' "$MUT_LOG" \
  || { echo "FAIL: missing recreate enqueue for wf-1000-1"; cat "$MUT_LOG"; exit 1; }
grep -qxF -- '--no-track recreate wf-1001-1' "$MUT_LOG" \
  || { echo "FAIL: missing recreate enqueue for wf-1001-1"; cat "$MUT_LOG"; exit 1; }

# Without a stall, running/completed workflows are not touched.
if grep -qxF -- '--no-track recreate wf-1002-1' "$MUT_LOG"; then
  echo "FAIL: unexpected recreate of running workflow before stall"; cat "$MUT_LOG"; exit 1
fi
if grep -qxF -- '--no-track recreate wf-1003-1' "$MUT_LOG"; then
  echo "FAIL: unexpected recreate of completed workflow"; cat "$MUT_LOG"; exit 1
fi

# ---------------------------------------------------------------------------
# Phase C — stall scenario: same incomplete count across STALL_CYCLES cycles
# triggers recreate of every incomplete workflow (including running).
# ---------------------------------------------------------------------------

MUT_LOG="$TMP/state/mutations-stall.log"
GIT_LOG="$TMP/state/git-stall.log"
# Cycle 1: baseline (streak=0). Cycle 2: streak=1. Cycle 3: streak=2 >= 2 → fire.
run_supervisor "$MUT_LOG" "$GIT_LOG" 3 2

grep -qxF -- '--no-track recreate wf-1002-1' "$MUT_LOG" \
  || { echo "FAIL: stall did not trigger recreate of running workflow"; cat "$MUT_LOG"; exit 1; }

# Completed workflows must stay untouched even under stall.
if grep -qxF -- '--no-track recreate wf-1003-1' "$MUT_LOG"; then
  echo "FAIL: stall recreate touched a completed workflow"; cat "$MUT_LOG"; exit 1
fi

# Fetch must be re-issued every cycle (3 of them here).
fetch_count="$(grep -cxF 'fetch upstream refs/heads/master:refs/remotes/upstream/master' "$GIT_LOG" || true)"
if [[ "$fetch_count" -ne 3 ]]; then
  echo "FAIL: expected 3 upstream fetches across 3 cycles, got $fetch_count"; cat "$GIT_LOG"; exit 1
fi

echo "PASS: prod-recreate-supervisor enforces upstream master ref sync, safe-mode git, and correct recreate enqueue shape"
