#!/usr/bin/env bash
# CodeRabbit PR #3042: failed/timed-out OMP runs are not counted against the
# attempt cap.
#
# When the master-head cron's initial suite fails it launches OMP to repair the
# tree. If `run_omp` itself fails or times out, the script used to exit (under
# `set -e`) BEFORE calling `ledger_record master-head-attempt ...`, so a run that
# burned an OMP invocation never counted toward
# INVOKER_MASTER_HEAD_AUTOFIX_MAX_ATTEMPTS. A repeatedly-failing OMP could then
# be re-launched every day forever, never tripping the cap it exists to enforce.
#
# This drives the REAL cron script offline with fakes: preflight tools are
# stubbed, the checkout is cloned from a local repo, the destructive suite is
# forced to fail, and a fake `omp` exits NON-ZERO on the repair invocation. A
# correct flow must record a `master-head-attempt` (with an omp-failed marker)
# before exiting, so the failure counts against the cap.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr3042-failed-omp.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && { echo "----- output -----"; echo "$2"; }; exit 1; }

# --- Source repo the cron will clone (local, offline). ---
SRC="$TMP/src"
mkdir -p "$SRC"
(
  cd "$SRC"
  git init -q -b master
  git config user.email ci@invoker.dev
  git config user.name "Invoker CI"
  echo "base" > file.txt
  git add file.txt
  git commit -q -m "base commit"
)

# --- Fake binaries so preflight passes and the OMP repair invocation FAILS. ---
mkdir -p "$TMP/bin"
for b in docker pnpm node gh; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/$b"
done
# omp: `omp models` (preflight auth check) -> ok; the repair invocation exits
# non-zero to simulate an OMP failure/crash.
cat > "$TMP/bin/omp" <<'OMP'
#!/usr/bin/env bash
if [ "${1:-}" = "models" ]; then
  echo "fake-model"
  exit 0
fi
echo "simulated omp failure" >&2
exit 7
OMP
chmod +x "$TMP"/bin/*

LEDGER="$TMP/ledger.tsv"
WORKDIR="$TMP/work"

run_cron() {
  PATH="$TMP/bin:$PATH" \
  INVOKER_MASTER_HEAD_AUTOFIX_REPO_URL="$SRC" \
  INVOKER_MASTER_HEAD_AUTOFIX_WORKDIR="$WORKDIR" \
  INVOKER_MASTER_HEAD_AUTOFIX_STATE_FILE="$LEDGER" \
  INVOKER_MASTER_HEAD_AUTOFIX_TEST_COMMAND='exit 1' \
  INVOKER_MASTER_HEAD_AUTOFIX_CONFIRM_FAILURE=0 \
  INVOKER_MASTER_HEAD_AUTOFIX_TEST_TIMEOUT_SECONDS=0 \
  INVOKER_MASTER_HEAD_AUTOFIX_OMP_TIMEOUT_SECONDS=0 \
  INVOKER_MASTER_HEAD_AUTOFIX_MAX_ATTEMPTS=3 \
  INVOKER_PR_CRON_LOCK="$TMP/cron.lock" \
  INVOKER_PR_CLAIM_LOCK_ROOT="$TMP/claims" \
  bash scripts/cron-master-head-test-autofix.sh 2>&1
}

# The suite fails and OMP fails, so the run exits non-zero; capture it either way.
out="$(run_cron || true)"

# Sanity: the flow must have reached the OMP repair path (a checkout was made).
checkout="$(find "$WORKDIR/runs" -mindepth 2 -maxdepth 2 -type d -name checkout | head -n1)"
[ -n "$checkout" ] || fail "no checkout dir was created; scenario did not run" "$out"

# The bug: a failed OMP run exits before recording an attempt, so nothing counts
# toward the cap. A correct flow records master-head-attempt with an omp-failed
# marker.
[ -f "$LEDGER" ] || fail "ledger was never written; failed OMP run recorded no attempt" "$out"
if ! awk -F '\t' \
  '$1 == "master-head-attempt" && $3 ~ /^omp-failed-/ { found = 1 } END { exit found ? 0 : 1 }' \
  "$LEDGER"; then
  fail "failed OMP run was not recorded as a master-head-attempt (attempt cap never advances)" \
    "$(printf 'ledger:\n%s\n\n%s' "$(cat "$LEDGER" 2>/dev/null)" "$out")"
fi

echo "[repro] PASS: a failed OMP run records a master-head-attempt before exiting."
