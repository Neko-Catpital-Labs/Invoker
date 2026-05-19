#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"

usage() {
  echo "Usage: bash scripts/verify-build-warning-clean.sh {export-order|targeted-builds|run-sh}" >&2
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

check_export_order() {
  node --input-type=module <<'NODE'
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const failures = [];

function visit(value, path, file) {
  if (Array.isArray(value) || value === null || typeof value !== 'object') {
    return;
  }

  const keys = Object.keys(value);
  const typesIndex = keys.indexOf('types');
  if (typesIndex !== -1) {
    const importIndex = keys.indexOf('import');
    const requireIndex = keys.indexOf('require');
    const lateAfter = [];
    if (importIndex !== -1 && typesIndex > importIndex) lateAfter.push('import');
    if (requireIndex !== -1 && typesIndex > requireIndex) lateAfter.push('require');
    if (lateAfter.length > 0) {
      failures.push(`${file} ${path}: types appears after ${lateAfter.join(' and ')}`);
    }
  }

  for (const [key, child] of Object.entries(value)) {
    visit(child, `${path}.${key}`, file);
  }
}

for (const name of readdirSync('packages')) {
  const file = join('packages', name, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  if (pkg.exports) {
    visit(pkg.exports, 'exports', file);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
NODE
}

check_stale_filters() {
  local stale
  local stale_pkg="@invoker/executor""s"
  stale="$(rg -n "$stale_pkg" run.sh scripts packages package.json pnpm-lock.yaml || true)"
  if [[ -n "$stale" ]]; then
    echo "$stale" >&2
    fail "stale executor package reference found in active launcher/helper paths"
  fi
}

fail_on_warning_markers() {
  local log_file="$1"
  local stale_pkg="@invoker/executor""s"
  if rg -n "will never be used|No projects matched the filters|$stale_pkg" "$log_file" >&2; then
    fail "warning marker found"
  fi
}

run_targeted_builds() {
  local log_file
  log_file="$(mktemp)"
  trap 'rm -f "$log_file"' RETURN

  pnpm --filter @invoker/core build 2>&1 | tee -a "$log_file"
  pnpm --filter @invoker/persistence build 2>&1 | tee -a "$log_file"
  pnpm --filter @invoker/app build 2>&1 | tee -a "$log_file"
  fail_on_warning_markers "$log_file"
}

case "$MODE" in
  export-order)
    check_export_order
    ;;
  targeted-builds)
    check_export_order
    run_targeted_builds
    ;;
  run-sh)
    check_export_order
    check_stale_filters
    ;;
  *)
    usage
    exit 64
    ;;
esac
