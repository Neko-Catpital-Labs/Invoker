#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_DIR="$ROOT/template"
TARGET_DIR="${1:-${TMPDIR:-/tmp}/invoker-first-agent-workflow}"
PLAN_DIR="$TARGET_DIR/invoker-plans"

if [ -e "$TARGET_DIR" ] && [ -n "$(find "$TARGET_DIR" -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
  echo "Target directory already exists and is not empty: $TARGET_DIR" >&2
  echo "Choose an empty path, or remove the directory and rerun this script." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
cp -R "$TEMPLATE_DIR"/. "$TARGET_DIR"/

(
  cd "$TARGET_DIR"
  git init -q
  git checkout -q -b main
  git config user.name "Invoker Tutorial"
  git config user.email "invoker-tutorial@example.com"
  git add package.json src test
  git commit -q -m "Initial failing greeter"
)

mkdir -p "$PLAN_DIR"
REPO_URL="$(cd "$TARGET_DIR" && pwd)"
REPO_URL_YAML="'$(printf "%s" "$REPO_URL" | sed "s/'/''/g")'"

write_plan() {
  local agent="$1"
  local path="$PLAN_DIR/first-agent-workflow-${agent}.yaml"

  cat > "$path" <<EOF
name: First agent workflow (${agent})
description: Fix a tiny Node greeter project, then verify it with node --test.
repoUrl: $REPO_URL_YAML
baseBranch: HEAD
onFinish: none
mergeMode: manual
tasks:
  - id: fix-greeter
    description: Fix the greeter implementation so the Node test suite passes.
    prompt: |
      You are working in a small Node.js project.

      Goal:
      - Make the existing test suite pass.

      Files:
      - src/greeter.js
      - test/greeter.test.js

      Acceptance criteria:
      - Do not change the tests unless they are clearly wrong.
      - Keep the implementation small.
      - Run npm test before finishing.
    executionAgent: ${agent}
    dependencies: []

  - id: verify
    description: Run the test suite after the agent fix.
    command: npm test
    dependencies: [fix-greeter]
EOF
}

write_plan codex
write_plan claude

cat <<EOF
Created tutorial project:
  $TARGET_DIR

Generated Invoker plans:
  $PLAN_DIR/first-agent-workflow-codex.yaml
  $PLAN_DIR/first-agent-workflow-claude.yaml

The initial tests intentionally fail. Use one of the generated plan files in Invoker.
EOF
