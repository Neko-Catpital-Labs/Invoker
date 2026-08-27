#!/usr/bin/env bash
# Prove plan-to-invoker hard-requires scrub-handoff-artifacts on PR-bound plans.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/handoff-scrub-gate.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

miss="$tmp/miss.yaml"
ok="$tmp/ok.yaml"

# Minimal PR-bound plan missing scrub-handoff-artifacts (other headings present).
cat > "$miss" <<'YAML'
name: "handoff-scrub-gate-miss"
description: |
  Goal: g
  Motivation: m
  Safety invariant: s
  Effectiveness measurement: leading a; lagging b beyond fixture e2e
  Verify: true
onFinish: pull_request
mergeMode: manual
repoUrl: https://github.com/Neko-Catpital-Labs/Invoker.git

tasks:
  - id: implement-thing
    description: |
      Goal: g
      Motivation: m
      Safety invariant: s
      Effectiveness measurement: leading a; lagging b beyond fixture e2e
      Review claim: c
      Review lane: behavior
      Slice rationale: s
      Architectural effect: none
      Alternative considerations: none
      Implementation details: n
      Non-goals: n
      Files: packages/app/src/main.ts
      Change types: modify
      Acceptance criteria:
      - `true`
      Layer: app_bridge
      Feature state: active
    prompt: |
      Assume no prior context. You are given only this task.
      Goal: g
      Motivation: m
      Safety invariant: s
      Effectiveness measurement: leading a; lagging b beyond fixture e2e
      Review claim: c
      Review lane: behavior
      Alternative considerations: none
      Implementation details: touch nothing harmful
      Non-goals: none
      Acceptance criteria:
      - `true`
    dependencies: []
YAML

# Same plan with required scrub-handoff-artifacts leaf.
cat > "$ok" <<'YAML'
name: "handoff-scrub-gate-ok"
description: |
  Goal: g
  Motivation: m
  Safety invariant: s
  Effectiveness measurement: leading a; lagging b beyond fixture e2e
  Verify: true
onFinish: pull_request
mergeMode: manual
repoUrl: https://github.com/Neko-Catpital-Labs/Invoker.git

tasks:
  - id: implement-thing
    description: |
      Goal: g
      Motivation: m
      Safety invariant: s
      Effectiveness measurement: leading a; lagging b beyond fixture e2e
      Review claim: c
      Review lane: behavior
      Slice rationale: s
      Architectural effect: none
      Alternative considerations: none
      Implementation details: n
      Non-goals: n
      Files: packages/app/src/main.ts
      Change types: modify
      Acceptance criteria:
      - `true`
      Layer: app_bridge
      Feature state: active
    prompt: |
      Assume no prior context. You are given only this task.
      Goal: g
      Motivation: m
      Safety invariant: s
      Effectiveness measurement: leading a; lagging b beyond fixture e2e
      Review claim: c
      Review lane: behavior
      Alternative considerations: none
      Implementation details: touch nothing harmful
      Non-goals: none
      Acceptance criteria:
      - `true`
    dependencies: []
  - id: scrub-handoff-artifacts
    description: |
      Goal: Remove ephemeral inter-task handoff files before merge.
      Motivation: Handoff must not ship in the PR.
      Safety invariant: Do not delete ledger.json under home invoker dir.
      Effectiveness measurement: Exit 0 only when handoff patterns are absent.
      Review claim: Worktree has no handoff JSON left for the PR.
      Review lane: cleanup
      Slice rationale: Required leaf before merge.
      Architectural effect: None.
      Alternative considerations: Shipping handoff files rejected.
      Implementation details: Run scripts/scrub-handoff-artifacts.sh
      Non-goals: No feature edits.
      Files: (handoff paths only)
      Change types: delete
      Acceptance criteria:
      - `bash scripts/scrub-handoff-artifacts.sh` exits 0
      Layer: e2e_regression
      Feature state: active
    command: "bash scripts/scrub-handoff-artifacts.sh"
    dependencies:
      - implement-thing
YAML

set +e
# Prefer atomicity lint once the gate exists; fall back to skill-doctor first-failed.
bash "$ROOT/skills/plan-to-invoker/scripts/lint-task-atomicity.sh" "$miss" >/tmp/miss-out 2>&1
miss_ec=$?
bash "$ROOT/skills/plan-to-invoker/scripts/lint-task-atomicity.sh" "$ok" >/tmp/ok-out 2>&1
ok_ec=$?
set -e

if [[ "$miss_ec" -eq 0 ]]; then
  echo "expected miss plan atomicity fail, got 0" >&2
  cat /tmp/miss-out >&2
  exit 1
fi
if [[ "$ok_ec" -ne 0 ]]; then
  echo "expected ok plan atomicity pass, got $ok_ec" >&2
  cat /tmp/ok-out >&2
  exit 1
fi
echo "handoff-scrub-gate-ok"
