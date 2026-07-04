#!/usr/bin/env bash
# CodeRabbit PR #3042: stale idempotency comment in the cron install test.
#
# This PR expanded the installer from two cron jobs to three and updated every
# count in scripts/test-install-pr-cron-jobs.sh accordingly -- the top-of-file
# doc comment, the "uninstall removes all three" comment, and both `-eq`
# assertions. One comment was missed: the idempotency re-run comment still read
# "still exactly two" while the assertion directly below it checks `-eq 3`, so
# the shipped test documents a count that contradicts what it actually asserts.
#
# This repro reads the REAL test script, derives the count claimed by the
# idempotency comment and the count checked by the first assertion after it, and
# fails when they disagree. It is not a literal string match: it compares the
# two numbers the file itself carries, so it stays meaningful if the counts
# change again.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TARGET="scripts/test-install-pr-cron-jobs.sh"

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && { echo "----- context -----"; echo "$2"; }; exit 1; }

[ -f "$TARGET" ] || fail "expected test script not found: $TARGET"

# awk states:
#   comment_n  = count the idempotency re-run comment claims (word or digit)
#   assert_n   = count the first `-eq N` assertion after that comment checks
# exit codes: 0 consistent, 1 mismatch (the bug), 2 comment carries no count,
#             3 idempotency comment not found.
result="$(awk '
  /#[[:space:]]*Idempotency/ && !seen_comment {
    line = $0
    if (line ~ /[Tt]hree/)     comment_n = 3
    else if (line ~ /[Tt]wo/)  comment_n = 2
    else if (line ~ /[Oo]ne/)  comment_n = 1
    else if (match(line, /[0-9]+/)) comment_n = substr(line, RSTART, RLENGTH)
    else comment_n = ""
    seen_comment = 1
    next
  }
  seen_comment && match($0, /-eq[[:space:]]+[0-9]+/) {
    s = substr($0, RSTART, RLENGTH)
    sub(/-eq[[:space:]]+/, "", s)
    assert_n = s
    if (comment_n == "") { print "no-count"; exit 2 }
    if (comment_n != assert_n) { print "mismatch " comment_n " " assert_n; exit 1 }
    print "ok " comment_n " " assert_n; exit 0
  }
  END { if (!seen_comment) { print "no-comment"; exit 3 } }
' "$TARGET")" && status=0 || status=$?

case "$status" in
  0) echo "[repro] PASS: idempotency comment count matches the assertion ($result)." ;;
  1) fail "idempotency comment count disagrees with its assertion ($result)" \
       "$(grep -n -A3 '#[[:space:]]*Idempotency' "$TARGET")" ;;
  2) fail "idempotency comment carries no count to check ($result)" \
       "$(grep -n -A3 '#[[:space:]]*Idempotency' "$TARGET")" ;;
  3) fail "no idempotency comment found in $TARGET ($result)" ;;
  *) fail "unexpected awk status $status ($result)" ;;
esac
