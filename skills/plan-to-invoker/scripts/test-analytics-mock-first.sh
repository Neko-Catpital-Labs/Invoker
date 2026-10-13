#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GATE="$REPO_ROOT/skills/plan-to-invoker/scripts/check-planning-completeness.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

write_plan() {
  local name="$1" deliverable_line="$2" mock_block="$3" collect_deps="$4"
  cat >"$WORK/$name.yaml" <<EOF
name: $name
scratch: true
onFinish: none
mergeMode: manual
${deliverable_line}
tasks:
${mock_block}
  - id: collect-data
    description: Collect the real data.
    command: echo collect
    dependencies: ${collect_deps}
EOF
}

MOCK_OK='  - id: mock-ui
    description: "Render the page on fake data. Definitions: p50 is the median MR time; p95 is the slowest 1 in 20. Mock approved: yes, user signed off on the mock page."
    command: echo mock
    dependencies: []'

MOCK_PENDING='  - id: mock-ui
    description: "Render the page on fake data. Definitions: p50 is the median MR time. Mock approved: pending"
    command: echo mock
    dependencies: []'

MOCK_REJECTED='  - id: mock-ui
    description: "Render the page on fake data. Definitions: p50 is the median MR time. Mock approved: rejected, user asked for changes"
    command: echo mock
    dependencies: []'

MOCK_AWAITING='  - id: mock-ui
    description: "Render the page on fake data. Definitions: p50 is the median MR time. Mock approved: awaiting review"
    command: echo mock
    dependencies: []'

MOCK_NO_DEFS='  - id: mock-ui
    description: "Render the page on fake data. Mock approved: yes, user signed off on the mock page."
    command: echo mock
    dependencies: []'

expect_gap() {
  local name="$1" field="$2"
  local out rc=0
  out="$(bash "$GATE" "$WORK/$name.yaml" 2>"$WORK/$name.err")" || rc=$?
  [[ $rc -eq 1 ]] || fail "$name: expected exit 1, got $rc: $(head -c 300 "$WORK/$name.err")"
  grep -q "\"field\": \"$field\"" <<<"$out" || fail "$name: expected gap field $field, got: $out $(head -c 300 "$WORK/$name.err")"
  echo "ok   $name -> gap $field"
}

expect_pass() {
  local name="$1"
  local rc=0
  bash "$GATE" "$WORK/$name.yaml" >/dev/null 2>"$WORK/$name.err" || rc=$?
  [[ $rc -eq 0 ]] || fail "$name: expected exit 0, got $rc: $(head -c 300 "$WORK/$name.err")"
  echo "ok   $name -> complete"
}

write_plan no-mock "deliverable: analytics" "" "[]"
expect_gap no-mock analyticsMock

write_plan collect-before-mock "deliverable: analytics" "$MOCK_OK" "[]"
expect_gap collect-before-mock analyticsMockOrder

write_plan mock-pending "deliverable: analytics" "$MOCK_PENDING" "[mock-ui]"
expect_gap mock-pending analyticsMockApproval

write_plan mock-rejected "deliverable: analytics" "$MOCK_REJECTED" "[mock-ui]"
expect_gap mock-rejected analyticsMockApproval

write_plan mock-awaiting "deliverable: analytics" "$MOCK_AWAITING" "[mock-ui]"
expect_gap mock-awaiting analyticsMockApproval

write_plan mock-no-definitions "deliverable: analytics" "$MOCK_NO_DEFS" "[mock-ui]"
expect_gap mock-no-definitions analyticsMockDefinitions

write_plan mock-first-ok "deliverable: analytics" "$MOCK_OK" "[mock-ui]"
expect_pass mock-first-ok

write_plan not-analytics "" "" "[]"
expect_pass not-analytics

echo "PASS: analytics mock-first gate (8 cases)"
