#!/usr/bin/env bash
# CodeRabbit PR #3042: no retention/cleanup for per-run checkout and logs.
#
# The master-head cron creates a fresh RUN_DIR (full clone + node_modules + test
# logs + visual-proof PNGs) on every daily invocation but never prunes old run
# directories, so disk usage grows without bound until the host fills up and
# every future run fails — undermining the reliability goal of this PR.
#
# This drives the REAL cron script offline with fakes, pre-seeding several old
# run directories. A run that keeps N runs must delete the excess so the number
# of run directories stays bounded (== retention, including the current run).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr3042-retention.XXXXXX")"
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

# --- Fake binaries so preflight passes; the destructive suite is "green". ---
mkdir -p "$TMP/bin"
for b in docker pnpm node gh; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/$b"
done
cat > "$TMP/bin/omp" <<'OMP'
#!/usr/bin/env bash
[ "${1:-}" = "models" ] && { echo fake-model; exit 0; }
exit 0
OMP
chmod +x "$TMP"/bin/*

WORKDIR="$TMP/work"
RETENTION=3

# Pre-seed 8 old run directories (older, lexically-smaller timestamp names).
mkdir -p "$WORKDIR/runs"
for i in 1 2 3 4 5 6 7 8; do
  mkdir -p "$WORKDIR/runs/2020010${i}T000000Z-$i/checkout"
done
seeded="$(find "$WORKDIR/runs" -mindepth 1 -maxdepth 1 -type d | wc -l)"
[ "$seeded" -eq 8 ] || fail "expected 8 seeded run dirs, found $seeded"

run_cron() {
  PATH="$TMP/bin:$PATH" \
  INVOKER_MASTER_HEAD_AUTOFIX_REPO_URL="$SRC" \
  INVOKER_MASTER_HEAD_AUTOFIX_WORKDIR="$WORKDIR" \
  INVOKER_MASTER_HEAD_AUTOFIX_STATE_FILE="$TMP/ledger.tsv" \
  INVOKER_MASTER_HEAD_AUTOFIX_TEST_COMMAND='exit 0' \
  INVOKER_MASTER_HEAD_AUTOFIX_CONFIRM_FAILURE=0 \
  INVOKER_MASTER_HEAD_AUTOFIX_TEST_TIMEOUT_SECONDS=0 \
  INVOKER_MASTER_HEAD_AUTOFIX_RUN_RETENTION="$RETENTION" \
  INVOKER_PR_CRON_LOCK="$TMP/cron.lock" \
  INVOKER_PR_CLAIM_LOCK_ROOT="$TMP/claims" \
  bash scripts/cron-master-head-test-autofix.sh 2>&1
}

# The suite is green, so the run exits 0 after recording green.
out="$(run_cron)" || fail "cron run did not exit 0 on a green suite" "$out"

remaining="$(find "$WORKDIR/runs" -mindepth 1 -maxdepth 1 -type d | wc -l)"
if [ "$remaining" -gt "$RETENTION" ]; then
  fail "run dirs are not pruned: $remaining remain (retention $RETENTION); disk grows unbounded" "$out"
fi

# The current run (a 2026-* dir) must survive, and the oldest seed must be gone.
find "$WORKDIR/runs" -mindepth 1 -maxdepth 1 -type d -name '2026*' | grep -q . \
  || fail "current run directory was pruned away" "$out"
[ ! -d "$WORKDIR/runs/20200101T000000Z-1" ] \
  || fail "oldest run dir survived; pruning kept the wrong set" "$out"

echo "[repro] PASS: old run directories are pruned to the retention window ($remaining <= $RETENTION)."
