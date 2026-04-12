#!/usr/bin/env bash
# Comprehensive Docker executor test suite.
#
# Exercises every Docker failure mode, concurrent execution, and terminal
# restoration. Replaces the earlier demo-provisioning-errors.* files.
#
# Usage:
#   ./scripts/test-docker-comprehensive.sh
#
# Prerequisites:
#   - Invoker built (pnpm build in packages/app)
#   - Docker daemon running
#   - invoker-agent:latest image available
#
# Safety:
#   Uses an isolated INVOKER_DB_DIR by default. This script does not touch
#   ~/.invoker/invoker.db unless INVOKER_DB_DIR is explicitly set to that path.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CREATED_TMP_DB_DIR=0
if [[ -z "${INVOKER_DB_DIR:-}" ]]; then
  export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-docker-comprehensive-db.XXXXXX")"
  CREATED_TMP_DB_DIR=1
fi
DB_PATH="$INVOKER_DB_DIR/invoker.db"
PLAN_FILE="$REPO_ROOT/plans/test-docker-comprehensive.yaml"

cleanup() {
  if [[ "$CREATED_TMP_DB_DIR" = "1" ]]; then
    rm -rf "$INVOKER_DB_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL + 1)); }
skip() { echo -e "  ${YELLOW}⊘${NC} $1 (skipped)"; SKIP=$((SKIP + 1)); }

# ── Pre-flight checks ───────────────────────────────────────

echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}  Docker Comprehensive Test Suite${NC}"
echo -e "${BOLD}========================================${NC}"
echo ""

echo "==> Pre-flight checks"

if ! docker info >/dev/null 2>&1; then
  echo -e "  ${RED}ERROR:${NC} Docker daemon is not running"
  exit 2
fi
pass "Docker daemon running"

if docker image inspect invoker-agent:latest >/dev/null 2>&1; then
  pass "invoker-agent:latest image exists"
else
  echo -e "  ${RED}ERROR:${NC} invoker-agent:latest image not found"
  echo "  Build it first: docker build -t invoker-agent:latest ."
  exit 2
fi

if [ ! -f "$DB_PATH" ] && ! command -v sqlite3 >/dev/null 2>&1; then
  echo -e "  ${RED}ERROR:${NC} sqlite3 is required but not installed"
  exit 2
fi
pass "sqlite3 available"

# ── Step 1: Clear previous state ────────────────────────────

echo ""
echo "==> Clearing previous Invoker state"
./run.sh --headless delete-all 2>/dev/null || true

# ── Step 2: Submit the plan ─────────────────────────────────

echo ""
echo "==> Submitting plan: $PLAN_FILE"
echo ""
./submit-plan.sh "$PLAN_FILE" || true

echo ""

# ── Step 3: Verify DB exists ────────────────────────────────

if [ ! -f "$DB_PATH" ]; then
  echo -e "${RED}ERROR:${NC} DB not found at $DB_PATH after plan execution"
  exit 2
fi

# ── Helper: query task output from DB ────────────────────────

task_output() {
  sqlite3 "$DB_PATH" "SELECT data FROM task_output WHERE task_id = '$1' ORDER BY id ASC;" 2>/dev/null || echo ""
}

task_status() {
  sqlite3 "$DB_PATH" "SELECT json_extract(data, '$.status') FROM tasks WHERE json_extract(data, '$.id') = '$1';" 2>/dev/null || echo "unknown"
}

task_container_id() {
  sqlite3 "$DB_PATH" "SELECT json_extract(data, '$.execution.containerId') FROM tasks WHERE json_extract(data, '$.id') = '$1';" 2>/dev/null || echo ""
}

# ── Step 4: Validate each task ──────────────────────────────

echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}  Task Results${NC}"
echo -e "${BOLD}========================================${NC}"

# --- docker-no-image: should fail with "No such image" ---
echo ""
echo "── docker-no-image ──"
OUTPUT=$(task_output "docker-no-image")
STATUS=$(task_status "docker-no-image")
echo "  Status: $STATUS"
if echo "$OUTPUT" | grep -qi "No such image\|not found\|image.*fail\|creation failed"; then
  pass "Provisioning error surfaced: non-existent image detected"
else
  fail "Expected 'No such image' error in output"
  echo "  Output: $(echo "$OUTPUT" | head -5)"
fi

# --- docker-cmd-exit-1: should fail with exit code 1 ---
echo ""
echo "── docker-cmd-exit-1 ──"
OUTPUT=$(task_output "docker-cmd-exit-1")
STATUS=$(task_status "docker-cmd-exit-1")
echo "  Status: $STATUS"
if [ "$STATUS" = "failed" ]; then
  pass "Task failed as expected (exit code 1)"
else
  fail "Expected status 'failed', got '$STATUS'"
fi
if echo "$OUTPUT" | grep -q "About to fail"; then
  pass "Command output captured before failure"
else
  fail "Expected 'About to fail' in output"
fi

# --- docker-cmd-crash: should fail with signal ---
echo ""
echo "── docker-cmd-crash ──"
OUTPUT=$(task_output "docker-cmd-crash")
STATUS=$(task_status "docker-cmd-crash")
echo "  Status: $STATUS"
if [ "$STATUS" = "failed" ]; then
  pass "Task failed as expected (crash/signal)"
else
  fail "Expected status 'failed', got '$STATUS'"
fi
if echo "$OUTPUT" | grep -q "About to crash"; then
  pass "Command output captured before crash"
else
  fail "Expected 'About to crash' in output"
fi

# --- docker-cmd-ok: should succeed ---
echo ""
echo "── docker-cmd-ok ──"
OUTPUT=$(task_output "docker-cmd-ok")
STATUS=$(task_status "docker-cmd-ok")
echo "  Status: $STATUS"
if [ "$STATUS" = "completed" ]; then
  pass "Task completed successfully"
else
  fail "Expected status 'completed', got '$STATUS'"
fi
if echo "$OUTPUT" | grep -q "DOCKER_CMD_OK"; then
  pass "Command output 'DOCKER_CMD_OK' persisted"
else
  fail "Expected 'DOCKER_CMD_OK' in output"
fi

# --- docker-cmd-output: should have stdout+stderr ---
echo ""
echo "── docker-cmd-output ──"
OUTPUT=$(task_output "docker-cmd-output")
STATUS=$(task_status "docker-cmd-output")
echo "  Status: $STATUS"
if [ "$STATUS" = "completed" ]; then
  pass "Task completed successfully"
else
  fail "Expected status 'completed', got '$STATUS'"
fi
if echo "$OUTPUT" | grep -q "STDOUT_LINE"; then
  pass "stdout output persisted"
else
  fail "Expected 'STDOUT_LINE' in output"
fi
if echo "$OUTPUT" | grep -q "STDERR_LINE"; then
  pass "stderr output persisted"
else
  fail "Expected 'STDERR_LINE' in output"
fi

# --- docker-concurrent-*: all three should complete ---
echo ""
echo "── docker-concurrent-a/b/c ──"
ALL_CONCURRENT_OK=true
for SUFFIX in a b c; do
  TASK_ID="docker-concurrent-$SUFFIX"
  OUTPUT=$(task_output "$TASK_ID")
  STATUS=$(task_status "$TASK_ID")
  MARKER="CONCURRENT_$(echo "$SUFFIX" | tr '[:lower:]' '[:upper:]')_DONE"

  if [ "$STATUS" = "completed" ] && echo "$OUTPUT" | grep -q "$MARKER"; then
    pass "$TASK_ID completed with correct output"
  else
    fail "$TASK_ID: status=$STATUS, expected marker=$MARKER"
    ALL_CONCURRENT_OK=false
  fi
done

# ── Step 5: Terminal restoration ─────────────────────────────

echo ""
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}  Terminal Restoration${NC}"
echo -e "${BOLD}========================================${NC}"

# Tasks that should have containers (all except docker-no-image which failed at creation)
RESTORABLE_TASKS="docker-cmd-exit-1 docker-cmd-crash docker-cmd-ok docker-cmd-output docker-concurrent-a docker-concurrent-b docker-concurrent-c"

for TASK_ID in $RESTORABLE_TASKS; do
  CID=$(task_container_id "$TASK_ID")
  if [ -z "$CID" ] || [ "$CID" = "null" ]; then
    fail "$TASK_ID: no container_id persisted in DB"
    continue
  fi

  # Attempt to restart and exec into the container
  if docker start "$CID" >/dev/null 2>&1 && \
     docker exec "$CID" /bin/sh -c 'echo RESTORE_OK' 2>/dev/null | grep -q "RESTORE_OK"; then
    pass "$TASK_ID: container ${CID:0:12} reattachable"
  else
    # Container might have been auto-removed; that's acceptable for crashed containers
    if [ "$(task_status "$TASK_ID")" = "failed" ]; then
      skip "$TASK_ID: container ${CID:0:12} not reattachable (failed task, acceptable)"
    else
      fail "$TASK_ID: container ${CID:0:12} not reattachable"
    fi
  fi
done

# docker-no-image should NOT have a container_id
CID_NO_IMAGE=$(task_container_id "docker-no-image")
if [ -z "$CID_NO_IMAGE" ] || [ "$CID_NO_IMAGE" = "null" ]; then
  pass "docker-no-image: no container_id (expected — provisioning failed before container creation)"
else
  fail "docker-no-image: unexpected container_id=$CID_NO_IMAGE"
fi

# ── Step 6: Cleanup ─────────────────────────────────────────

echo ""
echo "==> Cleaning up test containers"
for TASK_ID in $RESTORABLE_TASKS; do
  CID=$(task_container_id "$TASK_ID")
  if [ -n "$CID" ] && [ "$CID" != "null" ]; then
    docker stop "$CID" >/dev/null 2>&1 || true
    docker rm "$CID" >/dev/null 2>&1 || true
  fi
done

echo "==> Clearing Invoker state"
./run.sh --headless delete-all 2>/dev/null || true

# ── Summary ──────────────────────────────────────────────────

echo ""
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}  Summary${NC}"
echo -e "${BOLD}========================================${NC}"
echo -e "  ${GREEN}Passed:${NC}  $PASS"
echo -e "  ${RED}Failed:${NC}  $FAIL"
echo -e "  ${YELLOW}Skipped:${NC} $SKIP"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}FAILED${NC} — $FAIL assertion(s) failed"
  exit 1
else
  echo -e "${GREEN}ALL PASSED${NC}"
  exit 0
fi
