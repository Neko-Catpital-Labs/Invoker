#!/usr/bin/env bash
set -euo pipefail

# Root cause of "admin-bypass PRs never resolve": scripts/mergify_admin_requeue.py's
# run_logged() called `gh` once, with check=True and no timeout, and raised on the
# very first CalledProcessError. GitHub's GraphQL API (the `gh pr list ... --json
# ...,statusCheckRollup` query this script depends on) intermittently answers with
# HTTP 502/504 or an HTTP/2 stream reset — a known-transient condition, not a real
# failure. One blip killed the whole babysitting cycle.
#
# This script proves it two ways:
#   1. Against the last-committed version of the file (HEAD, before this fix): a
#      single simulated transient gh failure crashes run_logged. FAIL.
#   2. Against the current working tree (after this fix): the same failure is
#      retried and the call succeeds. PASS.
#
# No network access required — subprocess.run is mocked.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-mergify-transient-gh.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1"
  exit 1
}

BEFORE_DIR="$TMP/before"
mkdir -p "$BEFORE_DIR"
git show HEAD:scripts/mergify_admin_requeue_snapshot.py > "$BEFORE_DIR/mergify_admin_requeue_snapshot.py"
git show HEAD:scripts/mergify_admin_requeue_model.py > "$BEFORE_DIR/mergify_admin_requeue_model.py"

HARNESS="$TMP/harness.py"
cat > "$HARNESS" <<'PY'
import subprocess
import sys
from unittest import mock

sys.path.insert(0, sys.argv[1])
import mergify_admin_requeue_snapshot as s  # noqa: E402

transient = subprocess.CalledProcessError(
    1,
    ["gh", "pr", "list", "--repo", "Neko-Catpital-Labs/Invoker", "--label", "admin-bypass"],
    stderr="HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)",
)
success = subprocess.CompletedProcess(["gh", "pr", "list"], 0, stdout="[]", stderr="")

with mock.patch("mergify_admin_requeue_snapshot.subprocess.run", side_effect=[transient, success]) as run_mock:
    try:
        out = s.run_logged(["gh", "pr", "list", "--repo", "Neko-Catpital-Labs/Invoker", "--label", "admin-bypass"])
    except subprocess.CalledProcessError as exc:
        print(f"RESULT crashed calls={run_mock.call_count} stderr={exc.stderr!r}")
        sys.exit(1)
    print(f"RESULT succeeded calls={run_mock.call_count} out={out!r}")
    sys.exit(0)
PY

echo "[repro] === BEFORE (HEAD, unfixed run_logged) — one 502, then a clean success queued up ==="
if python3 "$HARNESS" "$BEFORE_DIR" 2>&1 | tee "$TMP/before.out"; then
  fail "expected the unfixed version to crash on the first transient error, but it succeeded"
fi
grep -q "^RESULT crashed calls=1 " "$TMP/before.out" || fail "unfixed version did not crash the way we expected (see output above)"
echo "[repro] confirmed: unfixed code died on attempt 1/1, never tried the call that would have succeeded"
echo

echo "[repro] === AFTER (current working tree, fixed run_logged) — same scenario ==="
python3 "$HARNESS" "scripts" | tee "$TMP/after.out"
grep -q "^RESULT succeeded calls=2 " "$TMP/after.out" || fail "fixed version did not retry-and-succeed as expected"
echo "[repro] confirmed: fixed code retried once and returned the successful result"
echo
echo "[repro] PASS: transient-gh-failure repro reproduced the bug on HEAD and confirmed the fix on the working tree"
