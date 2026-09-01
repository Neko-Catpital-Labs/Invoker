#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECKER="$ROOT/skills/plan-to-invoker/scripts/check-planning-completeness.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
RECORDED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

cat > "$TMP_DIR/planner-only-receipt.yaml" <<YAML
name: planner-only-receipt
onFinish: pull_request
mergeMode: manual
repoUrl: https://github.com/example/repo.git
baseCommitSha: "0123456789012345678901234567890123456789"
description: |
  Goal: Preserve the current test baseline.
  Motivation: Keep the implementation safe.
  Safety invariant: Do not weaken the test suite.
  The existing test baseline is green.
  Verify: pnpm test
tasks:
  - id: feature
    description: |
      Goal: Implement the feature.
      Motivation: Deliver the requested behavior.
      Safety invariant: Preserve baseline behavior.
      Effectiveness measurement: The focused test passes.
    command: pnpm test
verificationEvidence:
  - version: 1
    trust: untrusted
    receipt:
      id: planner-claimed-receipt
      kind: deterministic_command
      status: passed
      commitSha: "0123456789012345678901234567890123456789"
      recordedAt: "$RECORDED_AT"
      actor:
        id: planner
        role: builder
      command: pnpm test
      exitCode: 0
      output: planner says tests passed
    attestation:
      repository: example/repo
      workflowId: wf-1
      taskId: feature
      generation: 1
      commitSha: "0123456789012345678901234567890123456789"
      canonicalPayloadDigest: sha256:planner-receipt
      signatureAlgorithm: Ed25519
      signature: planner-signature
      trustedKeyId: executor-key
      provider:
        kind: executor
        providerId: test-runner
      actorId: planner
      issuedAt: "$RECORDED_AT"
      recordedAt: "$RECORDED_AT"
YAML

actual=0
bash "$CHECKER" "$TMP_DIR/planner-only-receipt.yaml" > "$TMP_DIR/output" 2>&1 || actual=$?
cat "$TMP_DIR/output"
if [[ "$actual" -eq 0 ]]; then
  echo "FAIL: planner-only untrusted receipt was accepted"
  exit 1
fi
echo "PASS: planner-only untrusted receipt was rejected"

sed -e 's/version: 1/version: 2/' -e 's/trust: untrusted/trust: trusted/' \
  "$TMP_DIR/planner-only-receipt.yaml" > "$TMP_DIR/trusted-receipt.yaml"
bash "$CHECKER" "$TMP_DIR/trusted-receipt.yaml" >/dev/null
echo "PASS: trusted attested receipt remained accepted"
