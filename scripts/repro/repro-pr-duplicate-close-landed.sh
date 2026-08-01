#!/usr/bin/env bash
# Battle-test: the duplicate-close cron correctly identifies PRs whose
# content is already on master, against a real sandbox git repo (the git
# facts are computed with real `git merge-base`/`diff`/`cherry`, not a fake)
# and a fake GitHub for the PR-listing/mutation side:
#   #901 head == origin/master tip -> landed via ancestry -> closed
#   #902 squash-equivalent content on master, never an ancestor -> landed via
#        empty-diff -> closed
#   #903 genuinely unmerged content -> left open (negative case)
# Then: DRY_RUN=1 -> logs the planned closes, submits nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-dup-close-landed.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home"
export FAKE_GH_STATE_DIR="$TMP/state"

# ── Sandbox git repo with a real "origin" remote ──
REPO="$TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q -b master
git -C "$REPO" config user.email "test@example.com"
git -C "$REPO" config user.name "Test"
echo base >"$REPO/base.txt"
git -C "$REPO" add base.txt
git -C "$REPO" commit -q -m "base commit"
git -C "$REPO" init -q --bare "$TMP/remote.git"
git -C "$REPO" remote add origin "$TMP/remote.git"
git -C "$REPO" push -q origin master

# #901: head is master's own tip -> trivially an ancestor of origin/master.
head_901="$(git -C "$REPO" rev-parse master)"

# #902: squash-equivalent. Feature branch adds squash.txt, never pushed;
# master separately gets a same-content commit and IS pushed, so
# origin/master's tip tree matches feature's tree even though feature's own
# commit is not (and never will be) an ancestor.
git -C "$REPO" checkout -q -b feature-902
echo squash-content >"$REPO/squash.txt"
git -C "$REPO" add squash.txt
git -C "$REPO" commit -q -m "feature: add squash.txt"
head_902="$(git -C "$REPO" rev-parse feature-902)"
git -C "$REPO" checkout -q master
echo squash-content >"$REPO/squash.txt"
git -C "$REPO" add squash.txt
git -C "$REPO" commit -q -m "master: squash-merged equivalent of #902"
git -C "$REPO" push -q origin master

# #903: genuinely unmerged, never pushed, unrelated content.
git -C "$REPO" checkout -q -b feature-903
echo unrelated-903 >"$REPO/only-903.txt"
git -C "$REPO" add only-903.txt
git -C "$REPO" commit -q -m "feature: genuinely unmerged change"
head_903="$(git -C "$REPO" rev-parse feature-903)"

git -C "$REPO" checkout -q master

# ── Fake GitHub state ──
python3 - "$FAKE_GH_STATE_DIR/state.json" "$head_901" "$head_902" "$head_903" <<'PY'
import json, sys
path, h901, h902, h903 = sys.argv[1:5]

def pr(number, head_ref_name, head_ref_oid):
    return {
        "number": number,
        "title": f"PR #{number}",
        "url": f"https://github.com/fake/repo/pull/{number}",
        "state": "OPEN",
        "isDraft": False,
        "baseRefName": "master",
        "headRefName": head_ref_name,
        "headRefOid": head_ref_oid,
        "mergeStateStatus": "CLEAN",
        "mergeable": "MERGEABLE",
        "reviewDecision": "",
        "labels": [],
        "reviewThreads": [],
        "checks": {},
    }

state = {
    "prs": [
        pr(901, "already-master-tip", h901),
        pr(902, "feature-902", h902),
        pr(903, "feature-903", h903),
    ],
    "issue_comments": {"901": [], "902": [], "903": []},
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2)
PY

ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
NODE_LOG="$TMP/node-calls.log"; : >"$NODE_LOG"
cat >"$TMP/bin/node" <<EOF
#!/usr/bin/env bash
printf 'node %s\n' "\$*" >> "$NODE_LOG"
last="\${@: -1}"
if [ -f "\$last" ]; then
  { printf -- '--- plan file: %s ---\n' "\$last"; cat "\$last"; printf -- '--- end plan ---\n'; } >> "$NODE_LOG"
fi
exit 0
EOF
chmod +x "$TMP/bin/node"

run_cron() {
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_GITHUB_TARGET_REPO="fake/repo" \
  INVOKER_PR_CRON_AUTHOR="fake-bot" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  INVOKER_PR_DUP_STATE_FILE="$TMP/ledger.jsonl" \
  INVOKER_PR_DUP_GIT_CWD="$REPO" \
  "$@" \
  bash "$ROOT/scripts/cron-pr-duplicate-close.sh" 2>&1
}

# ── DRY_RUN: correct classification, nothing submitted ──
out="$(run_cron env INVOKER_PR_CRON_DRY_RUN=1)" || fail "dry-run exited non-zero" "$out"
echo "$out" | grep -q "DRY-RUN close PR #901 reason=landed:ancestor" \
  || fail "dry-run: #901 must be planned as landed:ancestor" "$out"
echo "$out" | grep -q "DRY-RUN close PR #902 reason=landed:empty-diff" \
  || fail "dry-run: #902 must be planned as landed:empty-diff" "$out"
echo "$out" | grep -q "PR #903" \
  && fail "dry-run: unmerged #903 must never be planned" "$out"
[ -s "$NODE_LOG" ] && fail "dry-run must never invoke node/headless_mutation" "$(cat "$NODE_LOG")"

# ── Live run: submitted via headless_mutation run, ledger recorded ──
out="$(run_cron)" || fail "live run exited non-zero" "$out"
echo "$out" | grep -q "close PR #901 reason=landed:ancestor" \
  || fail "live run: #901 must be planned" "$out"
runs="$(grep -c "exec -- run " "$NODE_LOG" || true)"
[ "$runs" -eq 2 ] || fail "expected exactly 2 close submissions (#901, #902), got $runs" "$(cat "$NODE_LOG")"
grep -q "onFinish: none" "$NODE_LOG" || fail "generated close plan missing onFinish: none" "$(cat "$NODE_LOG")"
grep -q "gh pr close \"\$num\" --repo \"\$repo\"" "$NODE_LOG" \
  || fail "generated close plan missing the gh pr close command" "$(cat "$NODE_LOG")"
grep -q -- "--delete-branch" "$NODE_LOG" \
  && fail "generated close plan must never pass --delete-branch" "$(cat "$NODE_LOG")"
grep -q '"pr": 901' "$TMP/ledger.jsonl" || fail "ledger missing a row for #901" "$(cat "$TMP/ledger.jsonl")"
grep -q '"pr": 902' "$TMP/ledger.jsonl" || fail "ledger missing a row for #902" "$(cat "$TMP/ledger.jsonl")"
grep -q '"pr": 903' "$TMP/ledger.jsonl" && fail "ledger must never record #903" "$(cat "$TMP/ledger.jsonl")"

# ── Tick 2: same head-state -> ledger dedup, no re-submission ──
: >"$NODE_LOG"
out="$(run_cron)" || fail "tick 2 exited non-zero" "$out"
[ -s "$NODE_LOG" ] && fail "tick 2 must not resubmit already-closed PRs" "$(cat "$NODE_LOG")"

echo "[repro] passed"
