#!/usr/bin/env bash
# Self-contained END-TO-END proof for the coderabbit-address worker.
#
# Drives the REAL worker (scripts/cron-coderabbit-address.sh) against a LOCAL
# bare git repo standing in for GitHub — no network, no gh auth, no real LLM:
#
#   fake `gh`      -> serves the PR list, the CodeRabbit comment, and PR view
#   stubbed `omp`  -> the execution agent; writes a deterministic fix in the
#                     task worktree (Invoker auto-commits it)
#   real submit    -> the worker calls the real submit-plan.sh, which runs a
#                     real headless Invoker workflow (task -> merge gate)
#
# It proves the full chain: detect feedback -> build plan -> submit workflow ->
# agent fixes on the PR head branch -> merge gate force-pushes the repaired
# head branch back to origin, PRESERVING the PR's existing commits and WITHOUT
# touching the base branch.
#
# Skips cleanly (exit 0) if the app bundle is not built.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ ! -f packages/app/dist/main.js ]; then
  echo "[e2e] SKIP: packages/app/dist/main.js not built (run: pnpm --filter @invoker/app build)"
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-coderabbit-e2e.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[e2e] FAIL: $1"; [ -n "${2:-}" ] && { echo "----- log -----"; cat "$2"; }; exit 1; }

BARE="$TMP/repo.git"
SEED="$TMP/seed"
HEAD_BRANCH="feature/coderabbit-e2e"
BASE_BRANCH="master"
PR_NUM=4321
MARKER="2026-07-27T10:00:00Z"
export GIT_AUTHOR_NAME="cr-e2e" GIT_AUTHOR_EMAIL="cr-e2e@invoker"
export GIT_COMMITTER_NAME="cr-e2e" GIT_COMMITTER_EMAIL="cr-e2e@invoker"

# --- Local "GitHub": bare origin with master + a PR head branch that carries
#     the PR author's own commit (which the repair must preserve). ------------
git init --bare -q "$BARE"
git --git-dir="$BARE" symbolic-ref HEAD "refs/heads/$BASE_BRANCH"
git init -q "$SEED"
git -C "$SEED" config user.email cr-e2e@invoker
git -C "$SEED" config user.name cr-e2e
printf 'export function read(r){ return r.data[0]; }\n' > "$SEED/api.js"
git -C "$SEED" add api.js
git -C "$SEED" commit -qm "seed: api"
git -C "$SEED" branch -M "$BASE_BRANCH"
git -C "$SEED" remote add origin "$BARE"
git -C "$SEED" push -q origin "$BASE_BRANCH"
git -C "$SEED" checkout -q -b "$HEAD_BRANCH"
printf 'export const FEATURE = true;\n' > "$SEED/feature.js"   # the PR author's own work
git -C "$SEED" add feature.js
git -C "$SEED" commit -qm "feat: add feature.js (PR author commit)"
git -C "$SEED" push -q origin "$HEAD_BRANCH"
PR_HEAD_SHA="$(git --git-dir="$BARE" rev-parse "$HEAD_BRANCH")"

# --- Stubs on PATH ----------------------------------------------------------
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<GH
#!/usr/bin/env bash
case "\${1:-}" in
  pr)
    case "\${2:-}" in
      list)
        printf '%s\n' '[{"number":$PR_NUM,"url":"https://github.com/owner/repo/pull/$PR_NUM","headRefName":"$HEAD_BRANCH","baseRefName":"$BASE_BRANCH","title":"Add feature"}]'
        exit 0 ;;
      view)
        # Orphan guard asks for mergeable/mergeStateStatus/statusCheckRollup;
        # submit path asks for title/body/head/base. One clean payload serves both.
        printf '%s\n' '{"title":"Add feature","body":"Adds the feature.","headRefName":"$HEAD_BRANCH","baseRefName":"$BASE_BRANCH","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","statusCheckRollup":[]}'
        exit 0 ;;
    esac ;;
  api)
    case "\${2:-}" in
      */pulls/*/comments)
        printf '%s\n' '[{"user":{"login":"coderabbitai[bot]"},"body":"read() dereferences r.data without a null guard.","updated_at":"$MARKER","path":"api.js","html_url":"https://github.com/owner/repo/pull/$PR_NUM#discussion_r1"}]'
        exit 0 ;;
      */issues/*/comments)
        printf '[]\n'; exit 0 ;;
    esac ;;
esac
echo "fake gh: unhandled: \$*" >&2; exit 1
GH
chmod +x "$TMP/bin/gh"

# Stubbed omp execution agent: apply a deterministic fix in the worktree.
# Invoker auto-commits and pushes the task branch; the agent must NOT commit.
cat > "$TMP/bin/omp" <<'OMP'
#!/usr/bin/env bash
set -euo pipefail
# A real fix layered on top of the PR head checkout.
printf 'export function read(r){ if (!r || !r.data) return undefined; return r.data[0]; }\n' > api.js
printf 'coderabbit fix: null guard added\n' > coderabbit-fix.txt
exit 0
OMP
chmod +x "$TMP/bin/omp"

cat > "$TMP/review-gate.sh" <<'RG'
#!/usr/bin/env bash
printf '{}\n'
RG
chmod +x "$TMP/review-gate.sh"

echo '{"autoFixRetries":0}' > "$TMP/config.json"

# --- Run the REAL worker end-to-end ----------------------------------------
echo "[e2e] running coderabbit-address worker against local origin $BARE"
LOG="$TMP/worker.log"
set +e
env \
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_DB_DIR="$TMP/home/.invoker" \
  INVOKER_REPO_CONFIG_PATH="$TMP/config.json" \
  INVOKER_HEADLESS_STANDALONE=1 \
  INVOKER_OMP_COMMAND="$TMP/bin/omp" \
  INVOKER_GITHUB_TARGET_REPO="owner/repo" \
  INVOKER_PR_CRON_AUTHOR="cr-e2e-author" \
  INVOKER_PR_CRON_DRY_RUN=0 \
  INVOKER_PR_CODERABBIT_STATE_FILE="$TMP/ledger.tsv" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  INVOKER_PR_CRON_WORKDIR="$TMP/work" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
  INVOKER_PR_CODERABBIT_REPO_URL="file://$BARE" \
  bash scripts/cron-coderabbit-address.sh > "$LOG" 2>&1
WORKER_CODE=$?
set -e
sed 's/^/[worker] /' "$LOG" | tail -25

# --- Assertions -------------------------------------------------------------
[ "$WORKER_CODE" -eq 0 ] || fail "worker exited non-zero ($WORKER_CODE)" "$LOG"

grep -q "submitted CodeRabbit repair workflow" "$LOG" \
  || fail "worker did not report a submitted repair workflow" "$LOG"

awk -F '\t' -v m="$MARKER" '$1=="coderabbit" && $2=="'"$PR_NUM"'" && $3==m { ok=1 } END { exit ok?0:1 }' "$TMP/ledger.tsv" \
  || fail "success marker for PR #$PR_NUM @ $MARKER not recorded" "$LOG"

NEW_HEAD_SHA="$(git --git-dir="$BARE" rev-parse "$HEAD_BRANCH")"
[ "$NEW_HEAD_SHA" != "$PR_HEAD_SHA" ] \
  || fail "PR head branch $HEAD_BRANCH did not advance (still $PR_HEAD_SHA)" "$LOG"

git --git-dir="$BARE" cat-file -e "$HEAD_BRANCH:coderabbit-fix.txt" 2>/dev/null \
  || fail "fix file not pushed to PR head branch $HEAD_BRANCH" "$LOG"

# The PR author's own commit must survive (the fix layers ON TOP, not a rebuild).
git --git-dir="$BARE" cat-file -e "$HEAD_BRANCH:feature.js" 2>/dev/null \
  || fail "PR author's feature.js was LOST from $HEAD_BRANCH (head rebuilt from base?)" "$LOG"

# The fix actually changed the reviewed file.
git --git-dir="$BARE" show "$HEAD_BRANCH:api.js" | grep -q "null guard\|!r.data\|return undefined" \
  || fail "api.js on $HEAD_BRANCH does not contain the fix" "$LOG"

# Manual mergeMode must NOT advance the base branch.
if git --git-dir="$BARE" cat-file -e "$BASE_BRANCH:coderabbit-fix.txt" 2>/dev/null; then
  fail "fix leaked onto base branch $BASE_BRANCH (manual mode must not squash-merge)" "$LOG"
fi

echo "[e2e] PASS: worker submitted a repair workflow; merge gate pushed the fix"
echo "[e2e]       onto $HEAD_BRANCH ($PR_HEAD_SHA -> $NEW_HEAD_SHA), preserved the"
echo "[e2e]       PR author's feature.js, and left $BASE_BRANCH untouched."
echo "[repro] passed"
