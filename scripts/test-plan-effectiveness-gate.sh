#!/usr/bin/env bash
# Prove plan-to-invoker completeness hard-requires Effectiveness measurement.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/eff-gate.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

miss="$tmp/miss.yaml"
ok="$tmp/ok.yaml"

cat > "$miss" <<'YAML'
name: "effectiveness-gate-miss"
onFinish: none
mergeMode: no_op
repoUrl: https://github.com/Neko-Catpital-Labs/Invoker.git

tasks:
  - id: t1
    description: |
      Goal: x
      Motivation: y
      Safety invariant: z
      Review claim: c
      Review lane: docs
      Slice rationale: s
      Architectural effect: none
      Alternative considerations: none
      Implementation details: n
      Non-goals: n
      Layer: docs
      Feature state: active
      Acceptance criteria:
      - `true`
    command: "true"
    dependencies: []
YAML

cat > "$ok" <<'YAML'
name: "effectiveness-gate-ok"
onFinish: none
mergeMode: no_op
repoUrl: https://github.com/Neko-Catpital-Labs/Invoker.git

tasks:
  - id: t1
    description: |
      Goal: x
      Motivation: y
      Safety invariant: z
      Effectiveness measurement: leading signal A; lagging signal B beyond fixture e2e
      Review claim: c
      Review lane: docs
      Slice rationale: s
      Architectural effect: none
      Alternative considerations: none
      Implementation details: n
      Non-goals: n
      Layer: docs
      Feature state: active
      Acceptance criteria:
      - `true`
    command: "true"
    dependencies: []
YAML

set +e
bash "$ROOT/skills/plan-to-invoker/scripts/check-planning-completeness.sh" "$miss"
miss_ec=$?
bash "$ROOT/skills/plan-to-invoker/scripts/check-planning-completeness.sh" "$ok"
ok_ec=$?
set -e

if [[ "$miss_ec" -ne 1 ]]; then
  echo "expected miss plan exit 1, got $miss_ec" >&2
  exit 1
fi
if [[ "$ok_ec" -ne 0 ]]; then
  echo "expected ok plan exit 0, got $ok_ec" >&2
  exit 1
fi
echo "effectiveness-gate-ok"
