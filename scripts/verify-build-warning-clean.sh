#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mode="${1:-}"

usage() {
  echo "usage: bash scripts/verify-build-warning-clean.sh {export-order|targeted-builds|run-sh}" >&2
}

if [[ -z "$mode" ]]; then
  usage
  exit 64
fi

fail_if_warning_markers_present() {
  local log_file="$1"
  local warning_pattern='unreachable.*types|types.*unreachable|condition.*types.*will never be used|No projects matched the filters'
  if grep -Eiq "$warning_pattern" "$log_file"; then
    echo "FAIL: warning marker found in build output" >&2
    grep -Ein "$warning_pattern" "$log_file" >&2 || true
    exit 1
  fi
}

check_export_order() {
  node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const packagesDir = path.join(process.cwd(), 'packages');
const packageJsons = fs.readdirSync(packagesDir)
  .map((name) => path.join(packagesDir, name, 'package.json'))
  .filter((file) => fs.existsSync(file));

const violations = [];

function inspect(value, pointer, file) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;

  const keys = Object.keys(value);
  const typesIndex = keys.indexOf('types');
  if (typesIndex !== -1) {
    for (const condition of ['import', 'require']) {
      const conditionIndex = keys.indexOf(condition);
      if (conditionIndex !== -1 && typesIndex > conditionIndex) {
        violations.push(`${file}:${pointer}: types appears after ${condition}`);
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    inspect(child, `${pointer}/${key}`, file);
  }
}

for (const file of packageJsons) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.exports) inspect(data.exports, '/exports', path.relative(process.cwd(), file));
}

if (violations.length > 0) {
  console.error('FAIL: package export condition order is not clean');
  for (const violation of violations) console.error(violation);
  process.exit(1);
}
NODE
}

case "$mode" in
  export-order)
    check_export_order
    ;;
  targeted-builds)
    log_file="$(mktemp)"
    trap 'rm -f "$log_file"' EXIT
    pnpm --filter @invoker/core build 2>&1 | tee "$log_file"
    pnpm --filter @invoker/persistence build 2>&1 | tee -a "$log_file"
    pnpm --filter @invoker/app build 2>&1 | tee -a "$log_file"
    fail_if_warning_markers_present "$log_file"
    ;;
  run-sh)
    stale_filter="@invoker/""executors"
    if rg -n "$stale_filter" run.sh scripts package.json pnpm-lock.yaml packages >/dev/null; then
      echo "FAIL: stale $stale_filter reference found in active launcher/helper scope" >&2
      rg -n "$stale_filter" run.sh scripts package.json pnpm-lock.yaml packages >&2 || true
      exit 1
    fi
    ;;
  *)
    usage
    exit 64
    ;;
esac
