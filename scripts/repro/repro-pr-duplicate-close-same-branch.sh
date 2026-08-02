#!/usr/bin/env bash
# Battle-test: the duplicate-close cron correctly identifies open PRs that
# duplicate another open PR (never touching master), against a real sandbox
# git repo and a fake GitHub:
#   #1001/#1002 share the exact same head branch -> #1001 (older) closed as
#     duplicate of #1002 (kept, newer)
#   #1003/#1004 are on different branches but carry an identical net diff
#     (same patch-id) -> #1003 (older) closed as duplicate of #1004 (kept)
#   #1006/#1007 reproduce the real #4343/#4277 shape: #1006 is based on an
#     unmerged "integration" branch (its own unrelated prior commit), #1007
#     is based directly on master, and both carry the identical local
#     change -> #1006 closed as duplicate of #1007 (kept). This is the case
#     that was missed before same-diff comparison started diffing each PR
#     against its own base instead of always master.
#   #1005 is unrelated, unmerged, and alone -> left open (negative case)
# None of this content ever reaches master, so no "landed" signal fires for
# any of them — this exercises group_duplicates independently of
# classify_landed. Then: DRY_RUN=1 -> logs the planned closes, submits
# nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-dup-close-same-branch.XXXXXX")"
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

# #1001/#1002: two PRs on the literal same branch (same commit) -- the
# "duplicate slice twins" pattern from memory, never pushed to origin.
git -C "$REPO" checkout -q -b stack/dup
echo shared-work >"$REPO/dup.txt"
git -C "$REPO" add dup.txt
git -C "$REPO" commit -q -m "shared work"
head_dup="$(git -C "$REPO" rev-parse stack/dup)"

# #1003/#1004: different branches, identical net diff (same patch-id).
git -C "$REPO" checkout -q master
git -C "$REPO" checkout -q -b diff-a
echo identical-patch >"$REPO/samecontent.txt"
git -C "$REPO" add samecontent.txt
git -C "$REPO" commit -q -m "diff-a: add samecontent.txt"
head_1003="$(git -C "$REPO" rev-parse diff-a)"
git -C "$REPO" checkout -q master
git -C "$REPO" checkout -q -b diff-b
echo identical-patch >"$REPO/samecontent.txt"
git -C "$REPO" add samecontent.txt
git -C "$REPO" commit -q -m "diff-b: add samecontent.txt, same content"
head_1004="$(git -C "$REPO" rev-parse diff-b)"

# #1006/#1007: the real #4343/#4277 shape. #1006 is based on an unmerged
# "integration" branch that carries its own unrelated commit; #1007 is based
# directly on master. Both add the identical local change.
git -C "$REPO" checkout -q master
git -C "$REPO" checkout -q -b integration
echo integration-only >"$REPO/integration-only.txt"
git -C "$REPO" add integration-only.txt
git -C "$REPO" commit -q -m "integration: unrelated prior work"
git -C "$REPO" push -q origin integration

git -C "$REPO" checkout -q -b pr-1006
echo stacked-shared-content >"$REPO/stacked-shared.txt"
git -C "$REPO" add stacked-shared.txt
git -C "$REPO" commit -q -m "pr-1006: the actual change, stacked on integration"
head_1006="$(git -C "$REPO" rev-parse pr-1006)"

git -C "$REPO" checkout -q master
git -C "$REPO" checkout -q -b pr-1007
echo stacked-shared-content >"$REPO/stacked-shared.txt"
git -C "$REPO" add stacked-shared.txt
git -C "$REPO" commit -q -m "pr-1007: the identical change, based on master"
head_1007="$(git -C "$REPO" rev-parse pr-1007)"

# #1005: unrelated, unmerged, alone.
git -C "$REPO" checkout -q master
git -C "$REPO" checkout -q -b solo-1005
echo unrelated-1005 >"$REPO/only-1005.txt"
git -C "$REPO" add only-1005.txt
git -C "$REPO" commit -q -m "solo: genuinely unmerged, no duplicate"
head_1005="$(git -C "$REPO" rev-parse solo-1005)"

git -C "$REPO" checkout -q master

# ── Fake GitHub state ──
python3 - "$FAKE_GH_STATE_DIR/state.json" "$head_dup" "$head_1003" "$head_1004" "$head_1005" "$head_1006" "$head_1007" <<'PY'
import json, sys
path, head_dup, h1003, h1004, h1005, h1006, h1007 = sys.argv[1:8]

def pr(number, head_ref_name, head_ref_oid, base_ref_name="master"):
    return {
        "number": number,
        "title": f"PR #{number}",
        "url": f"https://github.com/fake/repo/pull/{number}",
        "state": "OPEN",
        "isDraft": False,
        "baseRefName": base_ref_name,
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
        pr(1001, "stack/dup", head_dup),
        pr(1002, "stack/dup", head_dup),
        pr(1003, "diff-a", h1003),
        pr(1004, "diff-b", h1004),
        pr(1005, "solo-1005", h1005),
        pr(1006, "pr-1006", h1006, base_ref_name="integration"),
        pr(1007, "pr-1007", h1007),
    ],
    "issue_comments": {str(n): [] for n in (1001, 1002, 1003, 1004, 1005, 1006, 1007)},
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

# ── DRY_RUN: correct grouping, nothing submitted ──
out="$(run_cron env INVOKER_PR_CRON_DRY_RUN=1)" || fail "dry-run exited non-zero" "$out"
echo "$out" | grep -q "DRY-RUN close PR #1001 reason=duplicate:same-branch kept=#1002" \
  || fail "dry-run: #1001 must be planned as a same-branch duplicate kept by #1002" "$out"
echo "$out" | grep -q "DRY-RUN close PR #1003 reason=duplicate:same-diff kept=#1004" \
  || fail "dry-run: #1003 must be planned as a same-diff duplicate kept by #1004" "$out"
echo "$out" | grep -q "DRY-RUN close PR #1006 reason=duplicate:same-diff kept=#1007" \
  || fail "dry-run: #1006 (stacked on integration) must be planned as a same-diff duplicate kept by #1007 (based on master)" "$out"
echo "$out" | grep -q "close PR #1002 " \
  && fail "dry-run: kept PR #1002 must never itself be planned for close" "$out"
echo "$out" | grep -q "close PR #1004 " \
  && fail "dry-run: kept PR #1004 must never itself be planned for close" "$out"
echo "$out" | grep -q "close PR #1005 " \
  && fail "dry-run: solo unmerged PR #1005 must never be planned" "$out"
echo "$out" | grep -q "close PR #1007 " \
  && fail "dry-run: kept PR #1007 must never itself be planned for close" "$out"
[ -s "$NODE_LOG" ] && fail "dry-run must never invoke node/headless_mutation" "$(cat "$NODE_LOG")"

# ── Live run: submitted via headless_mutation run, ledger recorded ──
out="$(run_cron)" || fail "live run exited non-zero" "$out"
runs="$(grep -c "exec -- run " "$NODE_LOG" || true)"
[ "$runs" -eq 3 ] || fail "expected exactly 3 close submissions (#1001, #1003, #1006), got $runs" "$(cat "$NODE_LOG")"
grep -q "kept=#1002" <<<"$out" || fail "live run must report #1002 as the kept PR for #1001" "$out"
grep -q "kept=#1007" <<<"$out" || fail "live run must report #1007 as the kept PR for #1006" "$out"
grep -q '"pr": 1001' "$TMP/ledger.jsonl" || fail "ledger missing a row for #1001" "$(cat "$TMP/ledger.jsonl")"
grep -q '"pr": 1003' "$TMP/ledger.jsonl" || fail "ledger missing a row for #1003" "$(cat "$TMP/ledger.jsonl")"
grep -q '"pr": 1006' "$TMP/ledger.jsonl" || fail "ledger missing a row for #1006" "$(cat "$TMP/ledger.jsonl")"
for untouched in 1002 1004 1005 1007; do
  grep -q "\"pr\": $untouched" "$TMP/ledger.jsonl" \
    && fail "ledger must never record kept/solo PR #$untouched" "$(cat "$TMP/ledger.jsonl")"
done

# ── Tick 2: same state -> ledger dedup, no re-submission ──
: >"$NODE_LOG"
out="$(run_cron)" || fail "tick 2 exited non-zero" "$out"
[ -s "$NODE_LOG" ] && fail "tick 2 must not resubmit already-closed duplicates" "$(cat "$NODE_LOG")"

echo "[repro] passed"
