#!/usr/bin/env bash
# Focused test for scripts/prod-recreate-supervisor.sh.
#
# Proves three things:
#   1. The script statically contains the upstream-fetch + update-ref host
#      ref sync (and rejects checkout/reset-hard / repo-pool mutation).
#   2. A single supervisor cycle invokes `git fetch upstream ...` and
#      `git update-ref refs/heads/master <sha>` against a stubbed git.
#   3. A single supervisor cycle enqueues `recreate <wf-id>` for failed
#      workflows (and only for failed workflows) via the stubbed headless
#      dispatcher — i.e. the recreate enqueue command shape is correct.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/prod-recreate-supervisor.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "FAIL: missing $SCRIPT" >&2
  exit 1
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Static-content assertions.
# ---------------------------------------------------------------------------

require_pattern() {
  local pattern="$1"
  local label="$2"
  if ! grep -Eq "$pattern" "$SCRIPT"; then
    fail "expected pattern not found in supervisor script: ${label} (/${pattern}/)"
  fi
}

reject_pattern() {
  local pattern="$1"
  local label="$2"
  if grep -Eq "$pattern" "$SCRIPT"; then
    fail "forbidden pattern present in supervisor script: ${label} (/${pattern}/)"
  fi
}

require_pattern 'fetch[[:space:]]+"?\$\{?UPSTREAM_REMOTE\}?"?[[:space:]]+\\?' \
  'git fetch upstream <refspec>'
require_pattern 'refs/heads/\$\{?UPSTREAM_BRANCH\}?:refs/remotes/\$\{?UPSTREAM_REMOTE\}?/\$\{?UPSTREAM_BRANCH\}?' \
  'refs/heads/<branch>:refs/remotes/<remote>/<branch> refspec'
require_pattern 'update-ref[[:space:]]+"refs/heads/\$\{?UPSTREAM_BRANCH\}?"' \
  'git update-ref refs/heads/<branch>'
require_pattern 'rev-parse[[:space:]]+"refs/remotes/\$\{?UPSTREAM_REMOTE\}?/\$\{?UPSTREAM_BRANCH\}?"' \
  'git rev-parse refs/remotes/<remote>/<branch>'

# Reject destructive paths that the task explicitly forbids.
reject_pattern 'git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?checkout[[:space:]]+(-[A-Za-z]+[[:space:]]+)*(master|\$\{?UPSTREAM_BRANCH\}?)' \
  'git checkout master'
reject_pattern 'reset[[:space:]]+--hard' \
  'git reset --hard'
reject_pattern 'repo-pool|repo_pool|repoPool' \
  'repo-pool mirror mutation'

# ---------------------------------------------------------------------------
# 2/3. Functional cycle with stubbed git + stubbed headless dispatcher.
# ---------------------------------------------------------------------------

TMP_DIR="$(mktemp -d -t prod-recreate-supervisor-test.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

GIT_LOG="$TMP_DIR/git.log"
HEADLESS_LOG="$TMP_DIR/headless.log"
FAKE_GIT="$TMP_DIR/fake-git"
FAKE_HEADLESS="$TMP_DIR/fake-headless"
FAKE_REPO="$TMP_DIR/repo"

mkdir -p "$FAKE_REPO"

cat >"$FAKE_GIT" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
LOG="${FAKE_GIT_LOG:?missing FAKE_GIT_LOG}"
printf '%s\n' "$*" >>"$LOG"

# Strip "-C <dir>" so we can dispatch on the verb.
args=("$@")
if [[ "${#args[@]}" -ge 2 && "${args[0]}" == "-C" ]]; then
  args=("${args[@]:2}")
fi

case "${args[0]:-}" in
  fetch)
    exit 0
    ;;
  rev-parse)
    # Deterministic 40-char SHA for the upstream master refname.
    echo "deadbeefcafef00ddeadbeefcafef00ddeadbeef"
    ;;
  update-ref)
    exit 0
    ;;
  *)
    echo "fake-git: unsupported verb: ${args[0]:-}" >&2
    exit 2
    ;;
esac
BASH
chmod +x "$FAKE_GIT"

cat >"$FAKE_HEADLESS" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
LOG="${FAKE_HEADLESS_LOG:?missing FAKE_HEADLESS_LOG}"
printf '%s\n' "$*" >>"$LOG"

case "${1:-}" in
  query-workflows)
    cat <<'JSONL'
{"id":"wf-100-1","status":"failed"}
{"id":"wf-200-1","status":"completed"}
{"id":"wf-300-1","status":"running"}
JSONL
    ;;
  recreate)
    exit 0
    ;;
  *)
    echo "fake-headless: unsupported verb: ${1:-}" >&2
    exit 2
    ;;
esac
BASH
chmod +x "$FAKE_HEADLESS"

export FAKE_GIT_LOG="$GIT_LOG"
export FAKE_HEADLESS_LOG="$HEADLESS_LOG"

set +e
INVOKER_PROD_RECREATE_REPO="$FAKE_REPO" \
INVOKER_PROD_RECREATE_GIT_BIN="$FAKE_GIT" \
INVOKER_PROD_RECREATE_HEADLESS_CMD="$FAKE_HEADLESS" \
PROD_RECREATE_INTERVAL_SECONDS=1 \
PROD_RECREATE_MAX_CYCLES=1 \
PROD_RECREATE_STALL_CYCLES=999 \
bash "$SCRIPT" >"$TMP_DIR/supervisor.out" 2>&1
RC=$?
set -e

if [[ "$RC" -ne 0 ]]; then
  echo "FAIL: supervisor exited with rc=$RC" >&2
  cat "$TMP_DIR/supervisor.out" >&2
  exit 1
fi

# Verify the fetch + update-ref behavior actually ran against the stub.
if ! grep -Eq '^-C[[:space:]]+'"$FAKE_REPO"'[[:space:]]+fetch[[:space:]]+upstream[[:space:]]+refs/heads/master:refs/remotes/upstream/master$' "$GIT_LOG"; then
  echo "FAIL: expected upstream fetch call missing from git log" >&2
  cat "$GIT_LOG" >&2
  exit 1
fi

if ! grep -Eq '^-C[[:space:]]+'"$FAKE_REPO"'[[:space:]]+rev-parse[[:space:]]+refs/remotes/upstream/master$' "$GIT_LOG"; then
  echo "FAIL: expected rev-parse upstream call missing from git log" >&2
  cat "$GIT_LOG" >&2
  exit 1
fi

if ! grep -Eq '^-C[[:space:]]+'"$FAKE_REPO"'[[:space:]]+update-ref[[:space:]]+refs/heads/master[[:space:]]+deadbeefcafef00ddeadbeefcafef00ddeadbeef$' "$GIT_LOG"; then
  echo "FAIL: expected update-ref refs/heads/master <sha> call missing from git log" >&2
  cat "$GIT_LOG" >&2
  exit 1
fi

# Also assert the stub never saw the forbidden destructive verbs.
if grep -Eq '(^|[[:space:]])checkout($|[[:space:]])' "$GIT_LOG"; then
  echo "FAIL: supervisor invoked git checkout" >&2
  cat "$GIT_LOG" >&2
  exit 1
fi
if grep -Eq 'reset[[:space:]]+--hard' "$GIT_LOG"; then
  echo "FAIL: supervisor invoked git reset --hard" >&2
  cat "$GIT_LOG" >&2
  exit 1
fi

# Verify the recreate enqueue command shape: exactly the failed workflow
# is recreated, and no completed/running workflow is.
if ! grep -Fxq 'query-workflows' "$HEADLESS_LOG"; then
  echo "FAIL: expected 'query-workflows' call missing from headless log" >&2
  cat "$HEADLESS_LOG" >&2
  exit 1
fi
if ! grep -Fxq 'recreate wf-100-1' "$HEADLESS_LOG"; then
  echo "FAIL: expected 'recreate wf-100-1' enqueue call missing from headless log" >&2
  cat "$HEADLESS_LOG" >&2
  exit 1
fi
if grep -Fxq 'recreate wf-200-1' "$HEADLESS_LOG"; then
  echo "FAIL: completed workflow wf-200-1 should not be recreated outside of stall path" >&2
  cat "$HEADLESS_LOG" >&2
  exit 1
fi
if grep -Fxq 'recreate wf-300-1' "$HEADLESS_LOG"; then
  echo "FAIL: running workflow wf-300-1 should not be recreated outside of stall path" >&2
  cat "$HEADLESS_LOG" >&2
  exit 1
fi

echo "PASS: prod-recreate-supervisor.sh syncs master ref via update-ref and enqueues recreate for failed workflows"
