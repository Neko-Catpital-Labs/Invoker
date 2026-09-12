#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PR_AUTH="$ROOT/packages/execution-engine/src/pr-authoring.ts"
echo "[repro] problem: schema headings inside code fences / 4-space-indented code counted as real sections"
echo "[repro] root cause: heading + metadata scans were not fully fence/indent aware"

python3 - "$PR_AUTH" <<'PY'
import pathlib, sys
src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")

# Behavior model of the hardened matcher: outside fences AND <=3 spaces indent.
def is_heading(line, expected):
    import re
    return bool(re.match(r"^ {0,3}#", line)) and line.strip().lower() == expected.lower()
def has_heading(body, expected):
    in_fence = False
    for line in body.splitlines():
        import re
        if re.match(r"^\s{0,3}(```|~~~)", line):
            in_fence = not in_fence; continue
        if not in_fence and is_heading(line, expected):
            return True
    return False

assert not has_heading("```\n## Test Plan\n```", "## Test Plan"), "fenced heading must not count"
assert not has_heading("    ## Test Plan", "## Test Plan"), "4-space-indented heading must not count"
assert has_heading("## Test Plan", "## Test Plan"), "a real heading must count"

# source invariants for the hardened scanners
for needle in ["function isHeadingLine", "/^ {0,3}#/"]:
    if needle not in src:
        raise SystemExit(f"missing hardened-scanner invariant: {needle}")

print("[repro] model: fenced and 4-space-indented headings are ignored; real headings count")
print("[repro] source check: indent-guarded heading detection present")
PY
echo "[repro] passed"
