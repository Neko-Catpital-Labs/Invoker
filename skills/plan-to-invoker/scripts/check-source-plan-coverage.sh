#!/usr/bin/env bash
# Validate that a generated plan preserves concrete task IDs from a source plan.
set -euo pipefail

source_file="${1:?Usage: bash check-source-plan-coverage.sh <source-file> <plan-file>}"
plan_file="${2:?Usage: bash check-source-plan-coverage.sh <source-file> <plan-file>}"

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
node "$script_dir/check-source-plan-coverage.mjs" "$source_file" "$plan_file"
