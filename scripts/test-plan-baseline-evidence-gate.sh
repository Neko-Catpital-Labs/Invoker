#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$ROOT/skills/plan-to-invoker/scripts/check-planning-completeness.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/mixed-present-future.yaml" <<'YAML'
name: mixed-present-future
onFinish: pull_request
mergeMode: manual
repoUrl: https://github.com/example/repo.git
description: |
  Goal: Preserve the current test baseline.
  Motivation: Keep the implementation safe.
  Safety invariant: Do not weaken the test suite.
  The existing test baseline is green, and we will verify it with `pnpm test`.
tasks:
  - id: future-verification
    description: |
      Goal: Verify the baseline.
      Motivation: Establish current evidence.
      Safety invariant: Do not claim unexecuted results.
      Effectiveness measurement: The command reports its result.
    command: pnpm test
YAML

actual=0
bash "$CHECKER" "$TMP_DIR/mixed-present-future.yaml" > "$TMP_DIR/output" 2>&1 || actual=$?
cat "$TMP_DIR/output"
if [[ "$actual" -eq 0 ]]; then
  echo "FAIL: mixed present-tense/future-intent baseline claim was accepted" >&2
  exit 1
fi
echo "PASS: mixed present-tense/future-intent baseline claim was rejected"

sed 's/The existing test baseline is green, and we will verify it with `pnpm test`\./Keep the test suite green after the change./' \
  "$TMP_DIR/mixed-present-future.yaml" > "$TMP_DIR/future-only.yaml"
bash "$CHECKER" "$TMP_DIR/future-only.yaml" >/dev/null
echo "PASS: future-only post-change intent remained accepted"

bash "$ROOT/scripts/repro/repro-planner-only-receipt.sh"
echo "PASS: planner-only receipt provenance regression passed"

NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
BASE_SHA="0123456789012345678901234567890123456789"

trusted_evidence() {
  local status="$1" commit_sha="$2" recorded_at="$3" exit_code="$4" output="$5"
  cat <<YAML
verificationEvidence:
  - version: 2
    trust: trusted
    receipt:
      id: runner-receipt
      kind: deterministic_command
      status: $status
      commitSha: "$commit_sha"
      recordedAt: "$recorded_at"
      actor:
        id: test-runner
        role: executor
      command: pnpm test
      exitCode: $exit_code
      output: "$output"
    attestation:
      repository: example/repo
      workflowId: wf-1
      taskId: check
      generation: 1
      commitSha: "$commit_sha"
      canonicalPayloadDigest: sha256:runner-receipt
      signatureAlgorithm: Ed25519
      signature: runner-signature
      trustedKeyId: executor-key
      provider:
        kind: executor
        providerId: test-runner
      actorId: test-runner
      issuedAt: "$recorded_at"
      recordedAt: "$recorded_at"
YAML
}

run_case() {
  local name="$1" expected="$2" claim="$3" evidence="${4:-}"
  local file="$TMP_DIR/$name.yaml" actual=0
  {
    cat <<YAML
name: $name
onFinish: pull_request
mergeMode: manual
repoUrl: https://github.com/example/repo.git
baseCommitSha: "$BASE_SHA"
description: |
  Goal: Check the baseline.
  Motivation: Keep planning honest.
  Safety invariant: Do not claim unexecuted results.
  Verify: pnpm test
  $claim
tasks:
  - id: check
    description: |
      Goal: Check the baseline.
      Motivation: Keep planning honest.
      Safety invariant: Do not claim unexecuted results.
      Effectiveness measurement: The focused command reports its result.
    command: pnpm test
YAML
    if [[ -n "$evidence" ]]; then printf '%s\n' "$evidence"; fi
  } > "$file"
  bash "$CHECKER" "$file" > "$TMP_DIR/$name.output" 2>&1 || actual=$?
  if [[ "$actual" -ne "$expected" ]]; then
    cat "$TMP_DIR/$name.output"
    echo "FAIL: $name expected checker exit $expected, got $actual" >&2
    exit 1
  fi
  echo "PASS: $name"
}

run_case fresh-commit-bound 0 'The baseline is green.' "$(trusted_evidence passed "$BASE_SHA" "$NOW" 0 'Tests passed')"
run_case unverified-wording 0 'UNVERIFIED: The baseline is green.'
run_case baseline-repair-dependency 0 'A baseline-repair dependency must run before the green baseline can be verified.'
run_case ordinary-post-change-intent 0 'Keep the suite green after the change.'
run_case missing-evidence 1 'The baseline is green.'
run_case embedded-unverified-marker 1 'Note: UNVERIFIED: The baseline is green.'
run_case expired-evidence 1 'The baseline is green.' "$(trusted_evidence passed "$BASE_SHA" 2020-01-01T00:00:00.000Z 0 'Tests passed')"
run_case failed-evidence 1 'The baseline is green.' "$(trusted_evidence failed "$BASE_SHA" "$NOW" 1 'Tests failed')"
run_case wrong-commit-evidence 1 'The baseline is green.' "$(trusted_evidence passed "9999999999999999999999999999999999999999" "$NOW" 0 'Tests passed')"
run_case empty-output-evidence 1 'The baseline is green.' "$(trusted_evidence passed "$BASE_SHA" "$NOW" 0 '')"
run_case pseudo-evidence 1 'The baseline is green.' 'evidence: "Tests passed"'

echo "PASS: baseline evidence fixture matrix"
