#!/usr/bin/env bash
# Proof: no scoped repository path still mentions the deleted worker-session-mine
# skill directory. The sibling slice proves that skill folder under skills/ is
# gone; this one proves absence of *references* to its path under skills/,
# scripts/, and docs/, which is a distinct property from absence of the
# directory itself.
#
# Safety invariant: the search token is assembled from two fragments, and this
# header deliberately avoids writing the token as one word, so this proof file
# -- which lives under scripts/ and is therefore inside the search scope -- does
# not contain the contiguous literal path and thus never matches itself. Writing
# the token as a single word anywhere in this file would make this proof report
# a false positive against its own source and always fail.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

token="skills/""worker-session-mine"

if matches="$(git grep -n "$token" -- skills scripts docs)"; then
  echo "[repro] FAILED: the deleted skill path is still referenced under skills/, scripts/, or docs/:" >&2
  echo "$matches" | sed 's/^/  /' >&2
  exit 1
fi

echo "[repro] passed: no reference to the deleted skill path remains under skills/, scripts/, or docs/"
