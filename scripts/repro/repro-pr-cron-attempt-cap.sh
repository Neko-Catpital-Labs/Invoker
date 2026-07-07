#!/usr/bin/env bash
# End-to-end proof that the PR cron jobs cannot retry a failing operation
# forever (CodeRabbit findings: count attempts, not just successes).
#
# This drives REAL (non-dry) failure paths offline with fakes:
#   Job 2A: real git rebase hits a content conflict -> each run records one
#           conflict-rebase-attempt and exits 1.
#   Job 2B: required CI is red, fake omp exits non-zero -> each run records one
#           conflict-rebase-attempt and exits 1.
#   Job 1 : fake `gh repo clone` fails -> prepare_checkout fails after the
#           attempt is recorded -> each run records one coderabbit-attempt.
# After MAX attempts the next run hits the cap instead of dispatching again.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-attempt-cap.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin"

# ---------------------------------------------------------------------------
# Job 2A — direct PR rebase conflicts on every run.
# ---------------------------------------------------------------------------
J2_ORIGIN="$TMP/j2-origin.git"
J2_SEED="$TMP/j2-seed"
J2_HEAD_BRANCH="stack/test/pr-555"
J2_BASE_BRANCH="main"

git init --bare "$J2_ORIGIN" >/dev/null
git clone "$J2_ORIGIN" "$J2_SEED" >/dev/null 2>&1
git -C "$J2_SEED" config user.name "Invoker Repro"
git -C "$J2_SEED" config user.email "invoker-repro@example.com"
printf 'base\n' > "$J2_SEED/shared.txt"
git -C "$J2_SEED" add shared.txt
git -C "$J2_SEED" commit -m "base" >/dev/null
git -C "$J2_SEED" branch -M "$J2_BASE_BRANCH"
git -C "$J2_SEED" push origin "$J2_BASE_BRANCH" >/dev/null

git -C "$J2_SEED" checkout -b "$J2_HEAD_BRANCH" >/dev/null
printf 'head-change\n' > "$J2_SEED/shared.txt"
git -C "$J2_SEED" add shared.txt
git -C "$J2_SEED" commit -m "head change" >/dev/null
git -C "$J2_SEED" push origin "$J2_HEAD_BRANCH" >/dev/null

git -C "$J2_SEED" checkout "$J2_BASE_BRANCH" >/dev/null
printf 'base-change\n' > "$J2_SEED/shared.txt"
git -C "$J2_SEED" add shared.txt
git -C "$J2_SEED" commit -m "base change" >/dev/null
git -C "$J2_SEED" push origin "$J2_BASE_BRANCH" >/dev/null

export REPRO_J2_ORIGIN="$J2_ORIGIN"
export REPRO_J2_HEAD_BRANCH="$J2_HEAD_BRANCH"
export REPRO_J2_BASE_BRANCH="$J2_BASE_BRANCH"

cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  pr)
    case "${2:-}" in
      list)
        printf '%s\n' "[{\"number\":555,\"title\":\"conflict\",\"headRefName\":\"$REPRO_J2_HEAD_BRANCH\",\"baseRefName\":\"$REPRO_J2_BASE_BRANCH\",\"mergeable\":\"CONFLICTING\",\"mergeStateStatus\":\"DIRTY\",\"labels\":[]}]"
        exit 0
        ;;
      comment)
        exit 0
        ;;
    esac
    ;;
  repo)
    if [ "${2:-}" = "clone" ]; then
      git clone "$REPRO_J2_ORIGIN" "$4" >/dev/null 2>&1
      exit 0
    fi
    ;;
esac
echo "fake gh: unhandled: $*" >&2
exit 1
GH
chmod +x "$TMP/bin/gh"

J2_LEDGER="$TMP/j2.tsv"; : > "$J2_LEDGER"
run_job2() {
  PATH="$TMP/bin:$PATH" \
  GIT_AUTHOR_NAME="Invoker Repro" \
  GIT_AUTHOR_EMAIL="invoker-repro@example.com" \
  GIT_COMMITTER_NAME="Invoker Repro" \
  GIT_COMMITTER_EMAIL="invoker-repro@example.com" \
  INVOKER_PR_CRON_DRY_RUN=0 \
  INVOKER_PR_CONFLICT_STATE_FILE="$J2_LEDGER" \
  INVOKER_PR_CRON_LOCK="$TMP/j2.lock" \
  INVOKER_PR_CRON_WORKDIR="$TMP/work" \
  bash scripts/cron-pr-conflict-rebase.sh 2>&1
}

j2_state() {
  local head_sha base_sha
  head_sha="$(git -C "$J2_ORIGIN" rev-parse "refs/heads/$J2_HEAD_BRANCH")"
  base_sha="$(git -C "$J2_ORIGIN" rev-parse "refs/heads/$J2_BASE_BRANCH")"
  printf '%s:%s' "$head_sha" "$base_sha"
}

for i in 1 2 3; do
  out="$(run_job2 || true)"
  echo "$out" | grep -q "git rebase onto $J2_BASE_BRANCH failed" \
    || fail "Job 2A run $i: expected a real rebase conflict" "$out"
done
j2_marker="$(j2_state)"
n="$(awk -F'\t' -v marker="$j2_marker" '$1=="conflict-rebase-attempt" && $2=="555" && $3==marker {c++} END{print c+0}' "$J2_LEDGER")"
[ "$n" -eq 3 ] || fail "Job 2A: expected 3 recorded attempts, got $n"

out="$(run_job2 || true)"
echo "$out" | grep -q "giving up" \
  || fail "Job 2A: 4th run must hit the cap (giving up), not dispatch again" "$out"

# ---------------------------------------------------------------------------
# Job 2B — dequeued PR CI is red and omp fails every run.
# ---------------------------------------------------------------------------
J2B_ORIGIN="$TMP/j2b-origin.git"
J2B_SEED="$TMP/j2b-seed"
J2B_HEAD_BRANCH="stack/test/pr-557"
J2B_BASE_BRANCH="main"

git init --bare "$J2B_ORIGIN" >/dev/null
git clone "$J2B_ORIGIN" "$J2B_SEED" >/dev/null 2>&1
git -C "$J2B_SEED" config user.name "Invoker Repro"
git -C "$J2B_SEED" config user.email "invoker-repro@example.com"
printf 'base\n' > "$J2B_SEED/shared.txt"
git -C "$J2B_SEED" add shared.txt
git -C "$J2B_SEED" commit -m "base" >/dev/null
git -C "$J2B_SEED" branch -M "$J2B_BASE_BRANCH"
git -C "$J2B_SEED" push origin "$J2B_BASE_BRANCH" >/dev/null

git -C "$J2B_SEED" checkout -b "$J2B_HEAD_BRANCH" >/dev/null
printf 'queue\n' > "$J2B_SEED/queue.txt"
git -C "$J2B_SEED" add queue.txt
git -C "$J2B_SEED" commit -m "queue" >/dev/null
git -C "$J2B_SEED" push origin "$J2B_HEAD_BRANCH" >/dev/null

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
FAIL_CHECKS_JSON="$(jq 'map(if .name == "required-fast / Guardrails" then .conclusion = "FAILURE" else . end)' <<<"$SUCCESS_CHECKS_JSON")"

export REPRO_J2B_ORIGIN="$J2B_ORIGIN"
export REPRO_J2B_HEAD_BRANCH="$J2B_HEAD_BRANCH"
export REPRO_J2B_BASE_BRANCH="$J2B_BASE_BRANCH"
export REPRO_J2B_FAIL_CHECKS_JSON="$FAIL_CHECKS_JSON"

cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
current_head_sha() {
  git -C "$REPRO_J2B_ORIGIN" rev-parse "refs/heads/$1"
}
case "${1:-}" in
  pr)
    case "${2:-}" in
      list)
        printf '%s\n' "[{\"number\":557,\"title\":\"queue\",\"headRefName\":\"$REPRO_J2B_HEAD_BRANCH\",\"baseRefName\":\"$REPRO_J2B_BASE_BRANCH\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"labels\":[{\"name\":\"admin-bypass\"},{\"name\":\"dequeued\"}]}]"
        exit 0
        ;;
      view)
        printf '%s\n' "{\"title\":\"queue\",\"body\":\"body\",\"url\":\"https://example.test/pull/557\",\"headRefOid\":\"$(current_head_sha "$REPRO_J2B_HEAD_BRANCH")\",\"headRefName\":\"$REPRO_J2B_HEAD_BRANCH\",\"baseRefName\":\"$REPRO_J2B_BASE_BRANCH\",\"labels\":[{\"name\":\"admin-bypass\"},{\"name\":\"dequeued\"}],\"statusCheckRollup\":$REPRO_J2B_FAIL_CHECKS_JSON}"
        exit 0
        ;;
      comment|edit)
        exit 0
        ;;
    esac
    ;;
  repo)
    if [ "${2:-}" = "clone" ]; then
      git clone "$REPRO_J2B_ORIGIN" "$4" >/dev/null 2>&1
      exit 0
    fi
    ;;
esac
echo "fake gh: unhandled: $*" >&2
exit 1
GH
chmod +x "$TMP/bin/gh"

cat > "$TMP/fake-omp-fail.sh" <<'OMP'
#!/usr/bin/env bash
exit 1
OMP
chmod +x "$TMP/fake-omp-fail.sh"

J2B_LEDGER="$TMP/j2b.tsv"; : > "$J2B_LEDGER"
j2b_state() {
  local head_sha base_sha
  head_sha="$(git -C "$J2B_ORIGIN" rev-parse "refs/heads/$J2B_HEAD_BRANCH")"
  base_sha="$(git -C "$J2B_ORIGIN" rev-parse "refs/heads/$J2B_BASE_BRANCH")"
  printf '%s:%s' "$head_sha" "$base_sha"
}
printf 'conflict-rebase-await-ci\t557\t%s\t%s\n' "$(j2b_state)" "$(date +%s)" >> "$J2B_LEDGER"
run_job2b() {
  PATH="$TMP/bin:$PATH" \
  INVOKER_OMP_COMMAND="$TMP/fake-omp-fail.sh" \
  INVOKER_PR_CRON_DRY_RUN=0 \
  INVOKER_PR_CONFLICT_STATE_FILE="$J2B_LEDGER" \
  INVOKER_PR_CRON_LOCK="$TMP/j2b.lock" \
  INVOKER_PR_CRON_WORKDIR="$TMP/work-j2b" \
  bash scripts/cron-pr-conflict-rebase.sh 2>&1
}

for i in 1 2 3; do
  out="$(run_job2b || true)"
  echo "$out" | grep -q "omp exited non-zero" \
    || fail "Job 2B run $i: expected the CI fixer to fail" "$out"
done
j2b_marker="$(j2b_state)"
n="$(awk -F'\t' -v marker="$j2b_marker" '$1=="conflict-rebase-attempt" && $2=="557" && $3==marker {c++} END{print c+0}' "$J2B_LEDGER")"
[ "$n" -eq 3 ] || fail "Job 2B: expected 3 recorded attempts, got $n"

out="$(run_job2b || true)"
echo "$out" | grep -q "giving up" \
  || fail "Job 2B: 4th run must hit the cap, not launch omp again" "$out"

# ---------------------------------------------------------------------------
# Job 1 — omp attempt fails (clone fails) but the attempt is still counted.
# ---------------------------------------------------------------------------
cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
case "${1:-}" in
  pr)
    case "${2:-}" in
      list) printf '%s\n' '[{"number":556,"url":"https://github.com/o/r/pull/556","headRefName":"h","baseRefName":"main","title":"t"}]'; exit 0;;
      view) printf '%s\n' '{"title":"t","body":"b","headRefName":"h","baseRefName":"main"}'; exit 0;;
    esac;;
  api)
    case "${2:-}" in
      */pulls/*/comments) printf '%s\n' '[{"user":{"login":"coderabbitai[bot]"},"body":"x","updated_at":"2026-06-25T10:00:00Z"}]'; exit 0;;
      */issues/*/comments) printf '[]\n'; exit 0;;
    esac;;
  repo)
    [ "${2:-}" = "clone" ] && exit 1;;
esac
echo "fake gh: unhandled: $*" >&2; exit 1
GH
chmod +x "$TMP/bin/gh"

cat > "$TMP/review-gate-empty.sh" <<'RG'
#!/usr/bin/env bash
printf '{}\n'
RG
chmod +x "$TMP/review-gate-empty.sh"

J1_LEDGER="$TMP/j1.tsv"; : > "$J1_LEDGER"
run_job1() {
  PATH="$TMP/bin:$PATH" \
  INVOKER_PR_CRON_DRY_RUN=0 \
  INVOKER_PR_CODERABBIT_STATE_FILE="$J1_LEDGER" \
  INVOKER_PR_CRON_LOCK="$TMP/j1.lock" \
  INVOKER_PR_CRON_WORKDIR="$TMP/work" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate-empty.sh" \
  bash scripts/cron-coderabbit-address.sh 2>&1
}

for i in 1 2 3; do
  out="$(run_job1 || true)"
  echo "$out" | grep -q "clone failed" \
    || fail "Job 1 run $i: expected the omp checkout to fail" "$out"
done
n="$(awk -F'\t' '$1=="coderabbit-attempt" && $2=="556"{c++} END{print c+0}' "$J1_LEDGER")"
[ "$n" -eq 3 ] || fail "Job 1: expected 3 recorded attempts, got $n"

out="$(run_job1 || true)"
echo "$out" | grep -q "hit cap" \
  || fail "Job 1: 4th run must hit the cap, not attempt again" "$out"

echo "[repro] passed"
