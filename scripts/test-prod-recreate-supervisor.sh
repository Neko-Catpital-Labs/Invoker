#!/usr/bin/env bash
# Focused test for scripts/prod-recreate-supervisor.sh.
#
# Verifies:
#   * Static: script contains the upstream fetch + update-ref behavior, does
#     NOT use git checkout master or git reset --hard, and does NOT touch
#     repo-pool mirrors under $HOME/.invoker/repos.
#   * Static: recreate enqueue command shape uses
#     `node scripts/headless-ipc.js exec --no-track -- recreate <wf>`.
#   * Dynamic: running the supervisor in a sandbox repo with a stub run.sh
#     and stub headless-ipc.js fast-forwards refs/heads/master to the
#     upstream master sha without touching HEAD or the working tree, and
#     records the expected recreate enqueue argv.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/prod-recreate-supervisor.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$SCRIPT" ]] || fail "missing $SCRIPT"
command -v jq >/dev/null 2>&1 || fail "jq is required to run this test"

# ---------------------------------------------------------------------------
# Static source-text checks
# ---------------------------------------------------------------------------

# Only scan executable (non-comment) lines so prohibited-pattern checks aren't
# fooled by explanatory comments that mention the very patterns we forbid.
CODE_ONLY="$(mktemp)"
trap '{ rm -f "$CODE_ONLY"; rm -rf "${SBX:-}"; }' EXIT
grep -vE '^[[:space:]]*#' "$SCRIPT" > "$CODE_ONLY"

grep -q 'git fetch[^|]*refs/heads/master:refs/remotes/' "$CODE_ONLY" \
  || fail "expected supervisor to fetch refs/heads/master:refs/remotes/<upstream>/master"

grep -q 'git update-ref refs/heads/master' "$CODE_ONLY" \
  || fail "expected supervisor to update refs/heads/master via git update-ref"

if grep -E 'git[[:space:]]+checkout[[:space:]]+master' "$CODE_ONLY" >/dev/null; then
  fail "supervisor must not checkout master"
fi
if grep -E 'git[[:space:]]+reset[[:space:]]+--hard' "$CODE_ONLY" >/dev/null; then
  fail "supervisor must not use git reset --hard"
fi
if grep -E '\.invoker/repos' "$CODE_ONLY" >/dev/null; then
  fail "supervisor must not touch repo-pool mirrors (\$HOME/.invoker/repos)"
fi

grep -q 'node scripts/headless-ipc.js exec' "$CODE_ONLY" \
  || fail "expected supervisor to enqueue via 'node scripts/headless-ipc.js exec ...'"
grep -q -- '-- recreate' "$CODE_ONLY" \
  || fail "expected supervisor to dispatch recreate via headless-ipc exec '-- recreate <wf>'"

# ---------------------------------------------------------------------------
# Dynamic sandbox: exercise phase-1 ref sync + recreate enqueue shape
# ---------------------------------------------------------------------------

SBX="$(mktemp -d -t prod-recreate-supervisor-test.XXXXXX)"

# Upstream bare repo
git -c init.defaultBranch=master init -q --bare "$SBX/upstream.git"

# Local host repo with master at SHA_A; HEAD is on a feature branch to mirror
# production where the supervisor runs on an experiment branch, not on master.
HOST="$SBX/host"
git -c init.defaultBranch=master init -q "$HOST"
git -C "$HOST" config user.email "test@example.com"
git -C "$HOST" config user.name "test-user"
printf 'A\n' > "$HOST/README.md"
git -C "$HOST" add README.md
git -C "$HOST" commit -q -m "A"
SHA_A="$(git -C "$HOST" rev-parse HEAD)"
git -C "$HOST" remote add upstream "$SBX/upstream.git"
git -C "$HOST" push -q upstream master
git -C "$HOST" checkout -q -b feature-branch
SHA_FEATURE="$(git -C "$HOST" rev-parse HEAD)"

# Add a second commit on upstream via a separate working copy
WORK="$SBX/upstream-work"
git clone -q "$SBX/upstream.git" "$WORK"
git -C "$WORK" config user.email "test@example.com"
git -C "$WORK" config user.name "test-user"
printf 'B\n' >> "$WORK/README.md"
git -C "$WORK" commit -q -am "B"
git -C "$WORK" push -q origin master
SHA_B="$(git -C "$WORK" rev-parse HEAD)"

[[ "$SHA_A" != "$SHA_B" ]] || fail "test setup: SHA_A and SHA_B should differ"
[[ "$(git -C "$HOST" rev-parse refs/heads/master)" == "$SHA_A" ]] \
  || fail "test setup: host master should be at SHA_A before run"

mkdir -p "$HOST/scripts"
cp "$SCRIPT" "$HOST/scripts/prod-recreate-supervisor.sh"
chmod +x "$HOST/scripts/prod-recreate-supervisor.sh"

RECORD="$SBX/headless-ipc.log"

# Stub run.sh: first `query workflows` call returns one failed workflow,
# subsequent calls return an empty list so the supervisor exits cleanly.
# `query queue` always returns an empty queue.
cat > "$HOST/run.sh" <<'EOF'
#!/usr/bin/env bash
COUNT_FILE="${INVOKER_TEST_COUNT_FILE:?missing INVOKER_TEST_COUNT_FILE}"
args="$*"
if [[ "$args" == *"query workflows"* ]]; then
  n=0
  [[ -f "$COUNT_FILE" ]] && n=$(cat "$COUNT_FILE")
  if [[ "$n" -eq 0 ]]; then
    printf '[{"id":"wf-1-1","status":"failed","onFinish":"pull_request"}]\n'
  else
    printf '[]\n'
  fi
  echo $((n + 1)) > "$COUNT_FILE"
elif [[ "$args" == *"query queue"* ]]; then
  printf '{"running":[],"queued":[],"runningCount":0,"maxConcurrency":0}\n'
else
  printf '[]\n'
fi
EOF
chmod +x "$HOST/run.sh"

# Stub headless-ipc.js: append argv to the record file so we can assert shape.
cat > "$HOST/scripts/headless-ipc.js" <<'EOF'
const fs = require('fs');
const record = process.env.INVOKER_TEST_RECORD;
if (record) {
  fs.appendFileSync(record, process.argv.slice(2).join(' ') + '\n');
}
EOF

set +e
(
  cd "$HOST"
  INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS=1 \
  INVOKER_PROD_SUPERVISOR_MAX_CYCLES=4 \
  INVOKER_PROD_SUPERVISOR_STALL_CYCLES=99 \
  INVOKER_TEST_RECORD="$RECORD" \
  INVOKER_TEST_COUNT_FILE="$SBX/test-count" \
  bash scripts/prod-recreate-supervisor.sh "$SBX/supervisor.log"
)
rc=$?
set -e
if [[ "$rc" -ne 0 ]]; then
  echo "--- supervisor.log ---"
  cat "$SBX/supervisor.log" || true
  fail "supervisor exited non-zero (rc=$rc)"
fi

# refs/heads/master should now be at SHA_B (upstream's master) via update-ref.
post_master="$(git -C "$HOST" rev-parse refs/heads/master)"
[[ "$post_master" == "$SHA_B" ]] \
  || fail "expected refs/heads/master to be $SHA_B after sync, got $post_master"

# HEAD must remain on the feature branch (no checkout master) and at the
# feature SHA (no reset --hard moved it). Feature branch starts at SHA_A in
# this sandbox, so HEAD's commit should still be SHA_A.
post_branch="$(git -C "$HOST" rev-parse --abbrev-ref HEAD)"
[[ "$post_branch" == "feature-branch" ]] \
  || fail "HEAD should remain on feature-branch after sync, got $post_branch"
post_head="$(git -C "$HOST" rev-parse HEAD)"
[[ "$post_head" == "$SHA_FEATURE" ]] \
  || fail "HEAD commit should remain at $SHA_FEATURE after sync, got $post_head"

# Working tree must still be the SHA_A content; otherwise checkout/reset slipped in.
if grep -qx "B" "$HOST/README.md"; then
  fail "working tree must not pick up upstream content; checkout/reset suspected"
fi
grep -qx "A" "$HOST/README.md" || fail "working tree should be unchanged after ref sync"

# upstream remote tracking ref should be at SHA_B.
post_remote="$(git -C "$HOST" rev-parse refs/remotes/upstream/master)"
[[ "$post_remote" == "$SHA_B" ]] \
  || fail "expected refs/remotes/upstream/master to be $SHA_B, got $post_remote"

# Recorded enqueue shape: exec --no-track -- recreate wf-1-1
if ! grep -qx 'exec --no-track -- recreate wf-1-1' "$RECORD"; then
  echo "--- recorded headless-ipc invocations ---"
  cat "$RECORD" || true
  fail "expected recorded invocation 'exec --no-track -- recreate wf-1-1'"
fi

echo "PASS: prod-recreate-supervisor phase-1 ref sync + recreate enqueue shape verified"
