#!/usr/bin/env bash
# CodeRabbit PR #3042: `git diff --quiet` misses new untracked files.
#
# When OMP's repair consists solely of NEW (untracked) files rather than edits
# to tracked files, `git diff --quiet` reports "no diff" and the master-head
# cron records `master-head-attempt <sha> no-diff` and aborts — discarding a
# real fix and burning an attempt-cap slot.
#
# This drives the REAL cron script offline with fakes: preflight tools are
# stubbed, the checkout is cloned from a local repo, the destructive suite is
# forced to fail, and a fake `omp` produces ONLY an untracked file. A correct
# change detector must notice that untracked file and NOT record `no-diff`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr3042-untracked.XXXXXX")"
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

# --- Fake binaries so preflight passes and OMP adds only an untracked file. ---
mkdir -p "$TMP/bin"
for b in docker pnpm node gh; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/$b"
done
# omp: `omp models` (preflight auth check) -> ok; the repair invocation writes a
# single NEW untracked file into the checkout (cwd) and exits successfully.
cat > "$TMP/bin/omp" <<'OMP'
#!/usr/bin/env bash
if [ "${1:-}" = "models" ]; then
  echo "fake-model"
  exit 0
fi
printf 'fix\n' > omp-added-new-file.txt
exit 0
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

out="$(run_cron || true)"

# Sanity: the fake OMP must actually have produced an untracked file, otherwise
# the scenario is not exercising the change-detection path at all.
checkout="$(find "$WORKDIR/runs" -mindepth 2 -maxdepth 2 -type d -name checkout | head -n1)"
[ -n "$checkout" ] || fail "no checkout dir was created" "$out"
[ -f "$checkout/omp-added-new-file.txt" ] || fail "fake omp did not add an untracked file" "$out"

# The bug: a fix made solely of untracked files is recorded as no-diff.
if awk -F '\t' '$1 == "master-head-attempt" && $3 == "no-diff" { found = 1 } END { exit found ? 0 : 1 }' "$LEDGER"; then
  fail "untracked-only OMP fix was recorded as no-diff (change detection missed new files)" "$out"
fi

echo "[repro] PASS: untracked-only OMP fix is detected as a real change (no bogus no-diff)."
