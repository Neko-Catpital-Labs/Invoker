#!/usr/bin/env bash
# Verifies workspace-test.sh's CI-only flaky-exclude wiring by stubbing pnpm
# (recording its args) instead of running the real, slow workspace suite.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"; git checkout -- scripts/flaky-test-registry.json 2>/dev/null || true' EXIT

cat > "$STUB_DIR/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "pnpm-called: $*" >> "$PNPM_CALL_LOG"
exit 0
EOF
chmod +x "$STUB_DIR/pnpm"

CALL_LOG="$(mktemp)"

run_with_stub() {
  PATH="$STUB_DIR:$PATH" PNPM_CALL_LOG="$CALL_LOG" INVOKER_WORKSPACE_TEST_CONCURRENCY=1 "$@" bash scripts/workspace-test.sh >/dev/null
}

: > "$CALL_LOG"
run_with_stub env
if grep -q -- "--exclude" "$CALL_LOG"; then
  echo "FAIL: local run (no CI env var) must not pass any --exclude args" >&2
  cat "$CALL_LOG" >&2
  exit 1
fi
echo "ok: local run passes no --exclude args"

node scripts/flaky-test-registry.mjs quarantine "**/src/__tests__/task-panel-error.test.tsx" --reason "wiring test" --source manual
: > "$CALL_LOG"
run_with_stub env CI=1
if ! grep -q -- "--exclude \*\*/src/__tests__/task-panel-error.test.tsx" "$CALL_LOG"; then
  echo "FAIL: CI run must forward the quarantined glob as --exclude" >&2
  cat "$CALL_LOG" >&2
  exit 1
fi
echo "ok: CI run forwards the quarantined glob"
node scripts/flaky-test-registry.mjs restore "**/src/__tests__/task-panel-error.test.tsx"

: > "$CALL_LOG"
run_with_stub env CI=1
if grep -q -- "--exclude" "$CALL_LOG"; then
  echo "FAIL: after restore, CI run must not pass any --exclude args" >&2
  cat "$CALL_LOG" >&2
  exit 1
fi
echo "ok: CI run passes no --exclude args once the registry is empty again"

echo "OK: workspace-test.sh flaky-exclude wiring"
