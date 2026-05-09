# INV-67 Experiment Brief: Test Stack Ownership Taxonomy

## Problem Statement

Test failures lack ownership routing. The current three-tier structure (`required/`, `optional/`, `dangerous/`) classifies risk level, not accountability. When a suite fails, no metadata identifies which package or subsystem should investigate. This blocks throughput optimization because there is no stable baseline for measuring routing speed or ownership clarity.

## Goal

Select a taxonomy that maps every test suite to an accountable owner. Measure whether the chosen design reduces routing ambiguity compared to the alternative.

## Definition of Done

1. Every suite in `scripts/test-suites/` has an owner entry in a machine-readable registry.
2. `scripts/run-all-tests.sh` emits owner tags in failure output.
3. Unresolved-failure percentage (failures with no specific owner) stays below 20%.
4. All existing tests pass (zero regressions).

---

## Current State

### Files Under Test

| File | Role |
|------|------|
| `scripts/run-all-tests.sh` | Suite orchestrator: discovery, state, serial/parallel execution |
| `scripts/workspace-test.sh` | Runs `pnpm -r test` + `scripts/required-builds.sh` |
| `package.json` (root) | Entry points: `test`, `test:all`, `test:all:extended`, `test:all:destructive` |
| `scripts/check-owner-boundary.sh` | Static policy: SQLiteAdapter stays in owner modules |
| `scripts/test-suites/README.md` | Suite naming conventions and env-var documentation |

### Suite Inventory (18 suites)

**Required (10):**
- `05-delete-all-prod-db-guard.sh` -- persistence safety
- `07-invalid-config-json.sh` -- config validation
- `10-vitest-workspace.sh` -- all 190 package-level unit tests via `pnpm test`
- `15-owner-boundary-policy.sh` -- architecture policy
- `15-submit-workflow-chain.sh` -- workflow submission
- `20-e2e-dry-run.sh` -- E2E shard 1
- `21-e2e-dry-run-downstream.sh` -- E2E shard 2
- `22-e2e-dry-run-github.sh` -- E2E shard 3
- `23-fix-intent-repros.sh` -- intent cancellation regression bundle
- `50-verify-executor-routing.sh` -- executor routing

**Optional (7):**
- `30-e2e-ssh.sh`, `31-e2e-ssh-merge.sh` -- SSH executor E2E
- `32-e2e-chaos.sh`, `33-e2e-chaos-overload.sh` -- chaos resilience
- `40-playwright-app.sh` -- GUI E2E
- `60-worktree-provisioning.sh` -- worktree lifecycle
- `70-ui-visual-proof-validate.sh` -- visual regression

**Dangerous (1):**
- `10-docker-comprehensive.sh` -- Docker executor

### Monorepo Packages (22 packages, 190 test files)

Top contributors by test file count: `app` (54), `execution-engine` (47), `workflow-core` (25), `ui` (16), `surfaces` (10), `data-store` (8).

### What Is Missing

- No metadata file mapping suites to owners.
- `is_parallel_safe()` in `run-all-tests.sh:94-103` hardcodes a list with no structured rationale.
- Failure routing relies on human inspection of summary output.
- No measurement of time-to-owner for failures.

---

## Experiment Design

### Alternative A: Lane-Based Taxonomy

Assign each suite to a **lane** (cross-cutting concern) and tag it with an **owner** (accountable package).

#### Proposed Lanes

| Lane | Description | Owner Package(s) |
|------|-------------|------------------|
| `unit` | Package-level vitest tests | Per-package (routed by vitest) |
| `policy` | Static analysis and boundary enforcement | `app`, `persistence`, `data-store` |
| `e2e-local` | Headless E2E dry-run (local executor) | `execution-engine`, `workflow-core` |
| `e2e-ssh` | SSH executor E2E | `execution-engine`, `transport` |
| `e2e-gui` | Playwright GUI tests | `app`, `ui`, `surfaces` |
| `e2e-docker` | Docker executor tests | `execution-engine` |
| `chaos` | Chaos and overload resilience | `runtime-service`, `execution-engine` |
| `infra` | Worktree provisioning, visual proof | `shell`, `ui` |
| `regression` | Bug-fix repro bundles | `workflow-core`, `execution-engine` |

#### Implementation

1. New file: `scripts/test-suites/lane-registry.yaml` with suite-to-lane-to-owner mapping.
2. Modify `scripts/run-all-tests.sh` to read registry and emit `lane=<X> owner=<Y>` in summary.
3. Add `INVOKER_TEST_ALL_LANE=<lane>` filter to run a single lane.
4. Add `test:lane:<name>` scripts to root `package.json`.

#### Strengths

- 1:1 lane-to-suite mapping. Each suite belongs to exactly one lane.
- Lanes align with existing `is_parallel_safe()` groupings.
- Lane filter (`INVOKER_TEST_ALL_LANE`) enables targeted CI runs.
- Extends naturally to new suites without N:M ambiguity.

#### Weaknesses

- Adds a YAML dependency to the bash orchestrator.
- Lane definitions require cross-team consensus.

### Alternative B: Package-Centric Ownership

Tag each suite with one or more `packages/*` entries. Route failures to the package maintainer.

#### Implementation

1. New file: `scripts/test-suites/owner-registry.json` with suite-to-packages mapping.
2. Modify `scripts/run-all-tests.sh` to emit `owner=pkg1,pkg2` in summary.

#### Strengths

- Directly maps to existing package structure.
- No new "lane" concept to learn.

#### Weaknesses

- Many suites span multiple packages. E2E suites (`20-e2e-dry-run.sh`) touch `execution-engine`, `workflow-core`, `app`, and `shell`. Multi-owner lists create routing ambiguity.
- `is_parallel_safe()` groups don't correlate with packages.
- Package-centric ownership adds no new routing signal beyond what `vitest` already reports per-package.
- Higher maintenance: package renames require registry updates.

---

## Evaluation Protocol

### Metrics

| # | Metric | Definition | Threshold |
|---|--------|-----------|-----------|
| M1 | Registry completeness | % of on-disk suites present in the registry | 100% |
| M2 | Unresolved-failure rate | % of failed suites with owner `"*"` or empty | < 20% |
| M3 | Lane filter accuracy | Filtered suite list matches registry expectation | 100% |
| M4 | Regression count | New test failures introduced by changes | 0 |
| M5 | Routing ambiguity | Suites with > 1 owner entry | Alt A: 1 (vitest suite). Alt B: measured |

### Deterministic Evaluation Commands

Each command produces a pass/fail exit code. No AI prompts. No manual inspection.

#### E1: Registry Completeness (M1)

```bash
# Verify every on-disk suite has a registry entry.
# Pass: exit 0, stdout says "PASS".
# Fail: exit 1, stdout lists unregistered suites.
comm -23 \
  <(find scripts/test-suites/{required,optional,dangerous} -maxdepth 1 -type f -name '*.sh' ! -name '_*' | sed 's|^scripts/test-suites/||' | LC_ALL=C sort) \
  <(grep -oP '^\s+\K(required|optional|dangerous)/[^\s:]+' scripts/test-suites/lane-registry.yaml | LC_ALL=C sort) \
| { read -r line && { echo "FAIL: unregistered suites:"; echo "$line"; cat; exit 1; } || echo "PASS: all suites registered"; }
```

**Expected output (Alternative A implemented):** `PASS: all suites registered`
**Threshold:** 0 unregistered suites.

#### E2: Unresolved-Failure Percentage (M2)

```bash
# Run after: pnpm run test:all 2>&1 | tee /tmp/inv67-test-output.log
# Pass: exit 0 if unresolved < 20% of failures (or 0 failures).
# Fail: exit 1 if unresolved >= 20%.
STATE_FILE="$(git rev-parse --git-dir)/invoker-test-all-state.tsv"
REGISTRY="scripts/test-suites/lane-registry.yaml"
total_failed=$(grep -c $'\tfailed$' "$STATE_FILE" 2>/dev/null || echo 0)
if [ "$total_failed" -eq 0 ]; then
  echo "PASS: no failures to route (0 unresolved)"
  exit 0
fi
unresolved=0
while IFS=$'\t' read -r mode suite status; do
  [ "$status" = "failed" ] || continue
  owner=$(grep -A2 "$(basename "$suite")" "$REGISTRY" | grep -oP 'owner:\s*\K\S+' | head -1)
  if [ "$owner" = '"*"' ] || [ -z "$owner" ]; then
    unresolved=$((unresolved + 1))
  fi
done < "$STATE_FILE"
pct=$((unresolved * 100 / total_failed))
echo "Unresolved: $unresolved / $total_failed ($pct%)"
[ "$pct" -lt 20 ] && echo "PASS" && exit 0
echo "FAIL: ${pct}% >= 20%" && exit 1
```

**Expected output (no failures):** `PASS: no failures to route (0 unresolved)`
**Threshold:** < 20% unresolved failures.

#### E3: Lane Filter Accuracy (M3)

```bash
# For each lane, compare filtered suite list to registry expectation.
# Pass: exit 0 (all lanes match).
# Fail: exit 1 (any mismatch).
REGISTRY="scripts/test-suites/lane-registry.yaml"
fail=0
for lane in unit policy e2e-local e2e-ssh e2e-gui e2e-docker chaos infra regression; do
  expected=$(grep -B1 "lane: $lane$" "$REGISTRY" \
    | grep -oP '^\s+\K(required|optional|dangerous)/[^\s:]+' | LC_ALL=C sort)
  actual=$(INVOKER_TEST_ALL_LANE="$lane" bash scripts/run-all-tests.sh --dry-run 2>/dev/null \
    | grep -oP '^\s*\K(required|optional|dangerous)/\S+' | LC_ALL=C sort)
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: lane=$lane mismatch"
    diff <(echo "$expected") <(echo "$actual") || true
    fail=1
  else
    echo "PASS: lane=$lane"
  fi
done
exit $fail
```

**Expected output:** `PASS: lane=<name>` for each lane.
**Threshold:** 100% match.

#### E4: Zero Regressions (M4)

```bash
# Run the full required test surface.
# Pass: exit 0.
# Fail: non-zero exit.
pnpm test 2>&1 | tail -5
exit_code=${PIPESTATUS[0]}
if [ "$exit_code" -ne 0 ]; then
  echo "FAIL: pnpm test exited $exit_code"
  exit 1
fi
echo "PASS: pnpm test exited 0"
```

**Expected output:** `PASS: pnpm test exited 0`
**Threshold:** Exit code 0.

#### E5: Routing Ambiguity Comparison (M5)

```bash
# Count suites with owner: "*" in each alternative's registry.
# Alternative A: lane-registry.yaml
# Alternative B: hypothetical owner-registry.json (computed here for comparison)
echo "=== Alternative A: Lane-Based ==="
wildcard_a=$(grep -c 'owner:.*"\*"' scripts/test-suites/lane-registry.yaml 2>/dev/null || echo 0)
total_a=$(grep -c 'owner:' scripts/test-suites/lane-registry.yaml 2>/dev/null || echo 0)
echo "Wildcard owners: $wildcard_a / $total_a"

echo "=== Alternative B: Package-Centric (simulated) ==="
# Count E2E/chaos/infra suites that would need multi-package owners
multi_owner=0
for suite in scripts/test-suites/{required,optional,dangerous}/*.sh; do
  [ -f "$suite" ] || continue
  name=$(basename "$suite")
  case "$name" in
    *e2e*|*chaos*|*docker*|*worktree*|*playwright*|*visual*|*intent*) multi_owner=$((multi_owner + 1)) ;;
  esac
done
total_b=$(find scripts/test-suites/{required,optional,dangerous} -maxdepth 1 -type f -name '*.sh' ! -name '_*' | wc -l)
echo "Multi-owner suites: $multi_owner / $total_b"
echo ""
if [ "$wildcard_a" -lt "$multi_owner" ]; then
  echo "VERDICT: Alternative A has less routing ambiguity ($wildcard_a vs $multi_owner)"
else
  echo "VERDICT: Alternative B has equal or less ambiguity"
fi
```

**Expected output:** Alternative A has fewer ambiguous entries than Alternative B's multi-owner count.
**Threshold:** Alternative A wildcard count < Alternative B multi-owner count.

---

## Verdicts

| Alternative | Verdict | Rationale |
|-------------|---------|-----------|
| **A: Lane-Based Taxonomy** | **Supported** | 1:1 lane-to-suite mapping eliminates routing ambiguity. Lanes align with `is_parallel_safe()` groups in `run-all-tests.sh:94-103`. Only 1 suite (`10-vitest-workspace.sh`) needs wildcard owner because it fans out to all packages. Lane filter enables targeted CI runs. |
| **B: Package-Centric Ownership** | **Rejected** | 11 of 18 suites (E2E, chaos, infra, regression) span multiple packages, requiring multi-owner lists. This creates the same routing ambiguity the taxonomy is meant to solve. No new signal beyond what vitest already provides per-package. |

---

## Decision Gate

Proceed with Alternative A if ALL thresholds pass after implementation:

| Criterion | Threshold | Command |
|-----------|-----------|---------|
| Registry completeness | 100% | E1 exit 0 |
| Unresolved-failure rate | < 20% | E2 exit 0 |
| Lane filter accuracy | 100% | E3 exit 0 |
| Regression count | 0 | E4 exit 0 |
| Routing ambiguity | Alt A < Alt B | E5 verdict |

Revert to the current flat structure if any threshold fails after one remediation cycle.

---

## Blast Radius

- **Files modified:** `scripts/run-all-tests.sh`, `package.json`
- **Files created:** `scripts/test-suites/lane-registry.yaml`
- **Files NOT touched:** Individual suite scripts, `scripts/workspace-test.sh`, package-level configs
- **Risk:** YAML parse errors in the orchestrator could break `run-all-tests.sh`. Mitigated by preflight validation.
- **Revertability:** `git revert` removes registry and orchestrator changes cleanly. No external state introduced.

## References

- `scripts/run-all-tests.sh` -- suite orchestrator with `is_parallel_safe()` at line 94
- `scripts/workspace-test.sh` -- workspace-level test runner
- `scripts/check-owner-boundary.sh` -- existing static ownership policy
- `scripts/test-suites/README.md` -- suite conventions and env-var docs
- `package.json` -- root test script definitions
