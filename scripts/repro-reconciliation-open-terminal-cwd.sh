#!/usr/bin/env bash
# Regression guard: open-terminal for reconciliation resolves cwd under
# $INVOKER_DB_DIR/worktrees (not the Invoker monorepo root).
#
# Plan: pivot + experimentVariants + file:// bare repo; pivot gets workflow baseBranch
# on spawn so experiments can complete; reconciliation reaches needs_input.
#
# Prerequisites: pnpm --filter @invoker/app build (dist/main.js)
#
# Usage:
#   bash scripts/repro-reconciliation-open-terminal-cwd.sh
#
# Exit codes:
#   0 — effective cwd is under isolated INVOKER_DB_DIR/worktrees (fix in effect).
#   1 — preconditions failed or regression (cwd still monorepo root).
#
# Cleanup: temp INVOKER_DB_DIR + git bare repo; trap removes on exit.
set -euo pipefail

INVOKER_MONO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INVOKER_MONO"

MAIN_JS="$INVOKER_MONO/packages/app/dist/main.js"
if [[ ! -f "$MAIN_JS" ]]; then
  echo "Missing $MAIN_JS — run: pnpm --filter @invoker/app build" >&2
  exit 1
fi

SANDBOX_FLAG=()
if [[ "$(uname -s)" == "Linux" ]]; then
  SANDBOX_BIN=$(echo "$INVOKER_MONO"/node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox 2>/dev/null | head -1)
  if [[ -n "${SANDBOX_BIN:-}" ]] && ! stat -c '%U:%a' "$SANDBOX_BIN" 2>/dev/null | grep -q '^root:4755$'; then
    SANDBOX_FLAG=(--no-sandbox)
  fi
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/fake-home"
mkdir -p "$HOME"

export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_DB_DIR="$TMP/invoker-home"
mkdir -p "$INVOKER_DB_DIR" "$TMP/fake-bin"

cat > "$TMP/fake-bin/x-terminal-emulator" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/fake-bin/x-terminal-emulator"
export PATH="$TMP/fake-bin:$PATH"

if [[ "$(uname -s)" == "Linux" ]]; then
  export LIBGL_ALWAYS_SOFTWARE=1
fi

BARE_GIT="$TMP/plan-bare.git"
git init --bare "$BARE_GIT" >/dev/null
CLONE="$TMP/plan-clone"
git clone "$BARE_GIT" "$CLONE" >/dev/null
(
  cd "$CLONE"
  git config user.email repro@local
  git config user.name Repro
  echo "repro" >README.md
  # Minimal manifest so worktree provisioning (pnpm install) succeeds in temp worktrees.
  printf '%s\n' '{"name":"repro","private":true}' >package.json
  git add README.md package.json
  git commit -m "init"
  git branch -M main
  git push -u origin main
) >/dev/null

REPO_URL="file://$BARE_GIT"
PLAN_FILE="$TMP/repro-plan.yaml"
cat > "$PLAN_FILE" <<EOF
name: repro-reconciliation-open-terminal
description: Pivot + experiments → reconciliation needs_input
onFinish: none
repoUrl: $REPO_URL
baseBranch: main
tasks:
  - id: pivot
    description: Pivot with variants
    pivot: true
    dependencies: []
    experimentVariants:
      - id: exp-a
        description: Variant A
        command: "true"
      - id: exp-b
        description: Variant B
        command: "true"
EOF

run_headless() {
  # shellcheck disable=SC2086
  "$INVOKER_MONO/packages/app/node_modules/.bin/electron" "$MAIN_JS" ${SANDBOX_FLAG[@]:-} --headless "$@"
}

echo "==> Isolated INVOKER_DB_DIR=$INVOKER_DB_DIR"
echo "==> Plan repo: $REPO_URL"
echo "==> Run workflow (expect pivot-reconciliation → needs_input)"
run_headless delete-all >/dev/null 2>&1 || true
run_headless run "$PLAN_FILE"

RECON_ID="pivot-reconciliation"
echo ""
echo "==> Task status for $RECON_ID"
run_headless task-status "$RECON_ID" | tee "$TMP/status.txt"
if ! grep -qx 'needs_input' "$TMP/status.txt"; then
  echo "FAIL: expected $RECON_ID status needs_input" >&2
  exit 1
fi

echo ""
echo "==> open-terminal $RECON_ID (capture logs)"
set +e
run_headless open-terminal "$RECON_ID" 2>&1 | tee "$TMP/open.log"
set -e

if ! grep -q '\[open-terminal\] effective cwd=' "$TMP/open.log"; then
  echo "FAIL: missing open-terminal cwd log line" >&2
  exit 1
fi

EFFECTIVE_CWD=$(sed -n 's/.*\[open-terminal\] effective cwd=\([^ ]*\) (.*/\1/p' "$TMP/open.log" | tail -1)
if [[ -z "$EFFECTIVE_CWD" ]]; then
  echo "FAIL: could not parse effective cwd from log" >&2
  exit 1
fi

echo ""
echo "Parsed effective cwd: $EFFECTIVE_CWD"

if [[ "$EFFECTIVE_CWD" == "$INVOKER_MONO" ]]; then
  echo "FAIL: regression — open-terminal still uses Invoker monorepo root" >&2
  exit 1
fi

if [[ "$EFFECTIVE_CWD" != "$INVOKER_DB_DIR/"* ]] && [[ "$EFFECTIVE_CWD" != *"/worktrees/"* ]]; then
  echo "FAIL: expected cwd under \$INVOKER_DB_DIR/worktrees or path containing /worktrees/; got $EFFECTIVE_CWD" >&2
  exit 1
fi

echo ""
echo "PASS: reconciliation open-terminal cwd is a pool worktree path"
grep -E 'WorktreeExecutor|getRestoredTerminalSpec|effective cwd' "$TMP/open.log" | tail -5 || true

exit 0
