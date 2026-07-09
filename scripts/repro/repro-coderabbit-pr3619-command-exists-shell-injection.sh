#!/usr/bin/env bash
# Repro: CodeRabbit PR #3619 (Security & Privacy, Major) — commandExists() in
# startup-prerequisites.ts interpolates the probed command straight into `sh -c`.
# Preset tool names flow from user config (slackHarnessPresets[].tool) through
# runStartupPrerequisites -> checkPlanningToolsPresent/checkDefaultPresetTool ->
# isInstalled(preset.tool) -> commandExists(preset.tool), so a preset tool like
# `x; touch pwned` executes arbitrary shell (CWE-78 OS command injection).
#
# This repro extracts the REAL commandExists() from source, calls it with an
# injection payload, and fails if the injected command executed.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/packages/app/src/startup-prerequisites.ts"

if [[ ! -f "$SRC" ]]; then
  echo "[repro] FAIL: source not found: $SRC"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SENTINEL="$WORK/pwned"
HARNESS="$WORK/harness.mts"

# Extract the real commandExists function body verbatim (from its declaration to
# the first line that is a lone closing brace), so we test the shipped code, not
# a hand-copied approximation.
FN="$(awk '
  /export function commandExists\(/ { grab = 1 }
  grab { print }
  grab && /^}/ { exit }
' "$SRC")"

if [[ -z "$FN" ]]; then
  echo "[repro] FAIL: could not locate commandExists() in $SRC — update this repro."
  exit 1
fi

{
  echo "import { spawnSync } from 'node:child_process';"
  echo "$FN"
  # Injection payload: if the tool name is interpolated into the shell string,
  # the trailing `; touch` runs and creates the sentinel.
  echo "commandExists('nonexistent_tool_xyz; touch ${SENTINEL}');"
} > "$HARNESS"

node "$HARNESS" >/dev/null 2>&1 || true

if [[ -f "$SENTINEL" ]]; then
  echo "[repro] FAIL: commandExists executed injected shell — preset tool names are a command-injection surface (CWE-78)."
  exit 1
fi

echo "[repro] PASS: commandExists probes PATH without shell interpolation; injected command did not run."
