#!/usr/bin/env bash
# Guard proof for Job 2 (scripts/cron-pr-conflict-rebase.sh):
#   1. a DIRTY PR with no Invoker workflow mapping is still actionable
#   2. once a branch-state marker is in the ledger -> "already handled ...; skip"
#   3. once the per-state attempt cap is reached -> "giving up"
#   4. a genuinely new branch state gets a fresh budget
#   5. once rebased heads are on-base, pending CI on a dequeued PR is observed
#   6. completed failing CI on a dequeued PR launches the fixer
#   7. completed green CI on a dequeued PR triggers requeue
#
# Runs fully offline with a fake `gh`; touches only temp ledgers, locks, and
# local git remotes/worktrees.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-conflict.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

LEDGER="$TMP/ledger.tsv"; : > "$LEDGER"
ORIGIN="$TMP/origin.git"
SEED="$TMP/seed"
HEAD_BRANCH="stack/test/pr-501"
QUEUE_BRANCH="stack/test/pr-502"
BASE_BRANCH="main"

mkdir -p "$TMP/bin"

git init --bare "$ORIGIN" >/dev/null
git clone "$ORIGIN" "$SEED" >/dev/null 2>&1
git -C "$SEED" config user.name "Invoker Repro"
git -C "$SEED" config user.email "invoker-repro@example.com"
printf 'base\n' > "$SEED/shared.txt"
git -C "$SEED" add shared.txt
git -C "$SEED" commit -m "base" >/dev/null
git -C "$SEED" branch -M "$BASE_BRANCH"
git -C "$SEED" push origin "$BASE_BRANCH" >/dev/null

git -C "$SEED" checkout -b "$HEAD_BRANCH" >/dev/null
printf 'head\n' > "$SEED/head.txt"
git -C "$SEED" add head.txt
git -C "$SEED" commit -m "head" >/dev/null
git -C "$SEED" push origin "$HEAD_BRANCH" >/dev/null

git -C "$SEED" checkout "$BASE_BRANCH" >/dev/null

marker() {
  local branch="$1" head_sha base_sha
  head_sha="$(git -C "$ORIGIN" rev-parse "refs/heads/$branch")"
  base_sha="$(git -C "$ORIGIN" rev-parse "refs/heads/$BASE_BRANCH")"
  printf '%s:%s' "$head_sha" "$base_sha"
}

advance_base() {
  local msg="$1"
  git -C "$SEED" checkout "$BASE_BRANCH" >/dev/null
  printf '%s\n' "$msg" > "$SEED/base.txt"
  git -C "$SEED" add base.txt
  git -C "$SEED" commit -m "$msg" >/dev/null
  git -C "$SEED" push origin "$BASE_BRANCH" >/dev/null
}

SUCCESS_CHECKS_JSON="$(awk '
  /^  - name: admin-bypass$/ { in_rule = 1; next }
  in_rule && /^pull_request_rules:/ { exit }
  in_rule && /^    merge_conditions:/ { in_merge = 1; next }
  in_rule && in_merge && /^  - name:/ { exit }
  in_rule && in_merge && /^[[:space:]]*-[[:space:]]*check-success = / {
    sub(/^[[:space:]]*-[[:space:]]*check-success = /, "", $0)
    print
  }
' .mergify.yml | jq -Rnc '[inputs | select(length > 0) | {__typename:"CheckRun", name:., status:"COMPLETED", conclusion:"SUCCESS"}]')"

export REPRO_ORIGIN="$ORIGIN"
export REPRO_HEAD_BRANCH="$HEAD_BRANCH"
export REPRO_QUEUE_BRANCH="$QUEUE_BRANCH"
export REPRO_BASE_BRANCH="$BASE_BRANCH"
export REPRO_SUCCESS_CHECKS_JSON="$SUCCESS_CHECKS_JSON"

cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
current_head_sha() {
  git -C "$REPRO_ORIGIN" rev-parse "refs/heads/$1"
}
case "${1:-}" in
  pr)
    case "${2:-}" in
      list)
        case "${REPRO_MODE:-conflict}" in
          conflict)
            printf '%s\n' "[{\"number\":501,\"title\":\"conflict\",\"headRefName\":\"$REPRO_HEAD_BRANCH\",\"baseRefName\":\"$REPRO_BASE_BRANCH\",\"mergeable\":\"CONFLICTING\",\"mergeStateStatus\":\"DIRTY\",\"labels\":[]}]"
            ;;
          pending|failure|success)
            printf '%s\n' "[{\"number\":502,\"title\":\"queue\",\"headRefName\":\"$REPRO_QUEUE_BRANCH\",\"baseRefName\":\"$REPRO_BASE_BRANCH\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"labels\":[{\"name\":\"admin-bypass\"},{\"name\":\"dequeued\"}]}]"
            ;;
          *)
            echo "fake gh: unknown REPRO_MODE=${REPRO_MODE:-}" >&2
            exit 1
            ;;
        esac
        exit 0
        ;;
      view)
        case "${REPRO_MODE:-conflict}" in
          pending)
            printf '%s\n' "{\"title\":\"queue\",\"body\":\"body\",\"url\":\"https://example.test/pull/502\",\"headRefOid\":\"$(current_head_sha "$REPRO_QUEUE_BRANCH")\",\"headRefName\":\"$REPRO_QUEUE_BRANCH\",\"baseRefName\":\"$REPRO_BASE_BRANCH\",\"labels\":[{\"name\":\"admin-bypass\"},{\"name\":\"dequeued\"}],\"statusCheckRollup\":[{\"__typename\":\"CheckRun\",\"name\":\"build-artifacts\",\"status\":\"IN_PROGRESS\",\"conclusion\":\"\"}]}"
            exit 0
            ;;
          failure)
            printf '%s\n' "{\"title\":\"queue\",\"body\":\"body\",\"url\":\"https://example.test/pull/502\",\"headRefOid\":\"$(current_head_sha "$REPRO_QUEUE_BRANCH")\",\"headRefName\":\"$REPRO_QUEUE_BRANCH\",\"baseRefName\":\"$REPRO_BASE_BRANCH\",\"labels\":[{\"name\":\"admin-bypass\"},{\"name\":\"dequeued\"}],\"statusCheckRollup\":[{\"__typename\":\"CheckRun\",\"name\":\"dry-run / case-2\",\"status\":\"COMPLETED\",\"conclusion\":\"FAILURE\"}]}"
            exit 0
            ;;
          success)
            printf '%s\n' "{\"title\":\"queue\",\"body\":\"body\",\"url\":\"https://example.test/pull/502\",\"headRefOid\":\"$(current_head_sha "$REPRO_QUEUE_BRANCH")\",\"headRefName\":\"$REPRO_QUEUE_BRANCH\",\"baseRefName\":\"$REPRO_BASE_BRANCH\",\"labels\":[{\"name\":\"admin-bypass\"},{\"name\":\"dequeued\"}],\"statusCheckRollup\":$REPRO_SUCCESS_CHECKS_JSON}"
            exit 0
            ;;
        esac
        ;;
    esac
    ;;
  repo)
    if [ "${2:-}" = "clone" ]; then
      git clone "$REPRO_ORIGIN" "$4" >/dev/null 2>&1
      exit 0
    fi
    ;;
esac
echo "fake gh: unhandled: $*" >&2
exit 1
GH
chmod +x "$TMP/bin/gh"

export PATH="$TMP/bin:$PATH"
export INVOKER_PR_CRON_DRY_RUN=1
export INVOKER_PR_CONFLICT_STATE_FILE="$LEDGER"
export INVOKER_PR_CRON_LOCK="$TMP/crons.lock"
export INVOKER_PR_CRON_WORKDIR="$TMP/work"

run_mode() { REPRO_MODE="$1" bash scripts/cron-pr-conflict-rebase.sh 2>&1; }

advance_base "base-v1"
state1="$(marker "$HEAD_BRANCH")"
out="$(run_mode conflict)"
echo "$out" | grep -q "would rebase $HEAD_BRANCH onto $BASE_BRANCH at $state1" \
  || fail "branch 1: expected 'would rebase ... at $state1'" "$out"

printf 'conflict-rebase\t501\t%s\t%s\n' "$state1" "$(date +%s)" >> "$LEDGER"
out="$(run_mode conflict)"
echo "$out" | grep -q "already handled for state $state1; skip" \
  || fail "branch 2: expected 'already handled for state ...; skip'" "$out"

advance_base "base-v2"
state2="$(marker "$HEAD_BRANCH")"
printf 'conflict-rebase-attempt\t501\t%s\t%s\n' "$state2" "$(date +%s)" >> "$LEDGER"
printf 'conflict-rebase-attempt\t501\t%s\t%s\n' "$state2" "$(date +%s)" >> "$LEDGER"
printf 'conflict-rebase-attempt\t501\t%s\t%s\n' "$state2" "$(date +%s)" >> "$LEDGER"
out="$(run_mode conflict)"
echo "$out" | grep -q "giving up" \
  || fail "branch 3: expected 'giving up' at the attempt cap" "$out"

advance_base "base-v3"
state3="$(marker "$HEAD_BRANCH")"
out="$(run_mode conflict)"
echo "$out" | grep -q "would rebase $HEAD_BRANCH onto $BASE_BRANCH at $state3" \
  || fail "branch 4: a new branch state must get a fresh budget" "$out"

git -C "$SEED" checkout -b "$QUEUE_BRANCH" "$BASE_BRANCH" >/dev/null
git -C "$SEED" push origin "$QUEUE_BRANCH" >/dev/null

queue_state="$(marker "$QUEUE_BRANCH")"
out="$(run_mode pending)"
echo "$out" | grep -q "dequeued CI still pending for state $queue_state" \
  || fail "branch 5: expected pending dequeued-CI observation" "$out"

out="$(run_mode failure)"
echo "$out" | grep -q "would launch CI fixer for state $queue_state" \
  || fail "branch 6: expected completed failing dequeued CI to launch fixer" "$out"

out="$(run_mode success)"
echo "$out" | grep -q "would comment '@mergify queue' and remove 'dequeued' for state $queue_state" \
  || fail "branch 7: expected green dequeued CI to requeue PRs" "$out"

echo "[repro] passed"
