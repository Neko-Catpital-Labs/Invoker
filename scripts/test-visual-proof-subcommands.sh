#!/usr/bin/env bash
set -euo pipefail

# Test script for visual-proof subcommands acceptance criteria

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VP_SCRIPT="${SCRIPT_DIR}/ui-visual-proof.sh"

echo "=== Testing visual-proof subcommands ===" >&2
echo "" >&2

# Test 1: --help documents all subcommands
echo "[TEST 1] Verify --help documents all subcommands" >&2
HELP_OUTPUT=$(bash "$VP_SCRIPT" --help 2>&1 || true)
for subcommand in capture-before capture-after compare embed; do
  if ! echo "$HELP_OUTPUT" | grep -q "$subcommand"; then
    echo "FAIL: --help does not document '$subcommand'" >&2
    exit 1
  fi
done
echo "PASS: All subcommands documented in --help" >&2
echo "" >&2

# Test 2: compare fails fast when ffmpeg is missing (if ffmpeg not installed)
echo "[TEST 2] Verify compare fails when ffmpeg is missing" >&2
if ! command -v ffmpeg >/dev/null 2>&1; then
  TMPDIR2=$(mktemp -d)
  cd "$TMPDIR2"
  COMPARE_OUTPUT=$(bash "$VP_SCRIPT" compare 2>&1 || true)
  if ! echo "$COMPARE_OUTPUT" | grep -q "ffmpeg not found"; then
    echo "FAIL: compare did not report missing ffmpeg" >&2
    echo "Output was: $COMPARE_OUTPUT" >&2
    cd - >/dev/null
    rm -rf "$TMPDIR2"
    exit 1
  fi
  bash "$VP_SCRIPT" compare >/dev/null 2>&1 && {
    echo "FAIL: compare exited 0 when ffmpeg missing" >&2
    cd - >/dev/null
    rm -rf "$TMPDIR2"
    exit 1
  }
  cd - >/dev/null
  rm -rf "$TMPDIR2"
  echo "PASS: compare fails fast when ffmpeg missing" >&2
else
  echo "SKIP: ffmpeg is installed, cannot test prerequisite check" >&2
fi
echo "" >&2

# Test 3: compare returns non-zero when artifacts missing
echo "[TEST 3] Verify compare fails when artifacts missing" >&2
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
bash "$VP_SCRIPT" compare >/dev/null 2>&1 && {
  echo "FAIL: compare exited 0 when artifacts missing" >&2
  cd - >/dev/null
  rm -rf "$TMPDIR"
  exit 1
}
cd - >/dev/null
rm -rf "$TMPDIR"
echo "PASS: compare returns non-zero when artifacts missing" >&2
echo "" >&2

# Test 4: embed returns non-zero when artifacts missing
echo "[TEST 4] Verify embed fails when artifacts missing" >&2
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
bash "$VP_SCRIPT" embed >/dev/null 2>&1 && {
  echo "FAIL: embed exited 0 when artifacts missing" >&2
  cd - >/dev/null
  rm -rf "$TMPDIR"
  exit 1
}
cd - >/dev/null
rm -rf "$TMPDIR"
echo "PASS: embed returns non-zero when artifacts missing" >&2
echo "" >&2

# Test 5: Unknown subcommand fails
echo "[TEST 5] Verify unknown subcommand fails" >&2
bash "$VP_SCRIPT" invalid-subcommand >/dev/null 2>&1 && {
  echo "FAIL: unknown subcommand exited 0" >&2
  exit 1
}
echo "PASS: unknown subcommand returns non-zero" >&2
echo "" >&2

# Test 6: Legacy mode still works
echo "[TEST 6] Verify legacy mode (--validate) still works" >&2
bash "$VP_SCRIPT" --validate >/dev/null 2>&1 || VALIDATE_EXIT=$?
if [[ "${VALIDATE_EXIT:-0}" -eq 0 ]] || [[ "${VALIDATE_EXIT:-0}" -eq 1 ]]; then
  echo "PASS: legacy --validate mode executes" >&2
else
  echo "FAIL: legacy --validate mode failed unexpectedly (exit ${VALIDATE_EXIT})" >&2
  exit 1
fi
echo "" >&2

# Test 7: Stable output paths
echo "[TEST 7] Verify stable output paths" >&2
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
mkdir -p packages/app/e2e/visual-proof/{before,after}
touch packages/app/e2e/visual-proof/before/test.png
touch packages/app/e2e/visual-proof/after/test.png
bash "$VP_SCRIPT" embed >/dev/null 2>&1
if [[ ! -f "packages/app/e2e/visual-proof/EMBED.md" ]]; then
  echo "FAIL: embed did not create EMBED.md at expected path" >&2
  cd - >/dev/null
  rm -rf "$TMPDIR"
  exit 1
fi
cd - >/dev/null
rm -rf "$TMPDIR"
echo "PASS: embed creates output at stable path" >&2
echo "" >&2

echo "=== All tests passed ===" >&2
