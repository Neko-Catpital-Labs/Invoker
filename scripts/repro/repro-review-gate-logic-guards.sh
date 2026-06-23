#!/usr/bin/env bash
# Repro guards for the review-gate "logic" bugs found while landing the
# Multi PR Review Gate stack (#1757 / #1811 / #1865) and the sibling sites
# the same bug classes also occur in.
#
#   #1757  github remote trailing-slash rejected; whitespace-only / un-normalized
#          artifact identifiers accepted (pr-authoring AND contracts validation).
#   #1811  closed-but-approved PR mapped to "approved" -> completes a closed gate
#          (mapReviewGateArtifactStatus AND the scalar single-PR poll path).
#   #1865  late/post-approval poll could still write review-gate state.
#   #1760  plan-validator error index drifted after a skipped invalid artifact.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] contracts: review-gate artifact identifier validation (#1757 sibling)"
pnpm --filter @invoker/contracts exec vitest run \
  src/__tests__/repro-review-gate-validation-guards.test.ts

echo "[repro] execution-engine: pr-authoring + status precedence + stale-poll guard (#1757/#1811/#1865)"
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/repro-review-gate-logic-guards.test.ts

echo "[repro] plan validator: error index must track the ORIGINAL artifact index (#1760)"
plan="$(mktemp "${TMPDIR:-/tmp}/invoker-review-gate-drift.XXXXXX.yaml")"
trap 'rm -f "$plan"' EXIT
cat > "$plan" <<'EOF'
name: drift
onFinish: none
mergeMode: manual
repoUrl: git@github.com:user/repo.git
tasks:
  - id: t
    description: t
    command: printf 'ok\n'
    dependencies: []
reviewGate:
  artifacts:
    - title: no-id-here
      required: true
    - id: a
      title: A
      required: true
    - id: b
      title: B
      required: true
EOF
set +e
out="$(bash skills/plan-to-invoker/scripts/validate-plan.sh "$plan" 2>&1)"
exit_code=$?
set -e
if [[ $exit_code -eq 0 ]]; then
  echo "[repro] FAIL: validator must reject branched review-gate artifacts (non-zero exit)"
  echo "$out"
  exit 1
fi
# The dependency error must point at the ORIGINAL index [2] (artifact 'b'), not a
# re-indexed [1] after the invalid artifact[0] is skipped (#1760 index drift).
if ! echo "$out" | jq -e '
  [.[] | select(.errorType == "invalid_dependency_reference")] as $dep
  | ($dep | length) == 1
    and $dep[0].field == "reviewGate.artifacts[2].dependsOn"
    and ($dep[0].message | test("must be \\[\"a\"\\] to keep the review-gate stack linear"))
' >/dev/null; then
  echo "[repro] FAIL: linear-dependency error should point at original index [2] (artifact 'b')"
  echo "$out"
  exit 1
fi

echo "[repro] passed"
