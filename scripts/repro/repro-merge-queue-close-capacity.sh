#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

check_cleanup_contract() {
  node --input-type=module <<'NODE'
import { existsSync, readFileSync } from 'node:fs';

const path = '.github/workflows/merge-queue-close-cleanup.yml';
if (!existsSync(path)) {
  throw new Error('capacity leak reproduced: closed merge-queue wrappers have no cleanup workflow');
}

const source = readFileSync(path, 'utf8');
for (const expected of [
  'types: [closed]',
  'group: CI-merge-queue-${{ github.head_ref }}',
  'group: PR Body-merge-queue-${{ github.head_ref }}',
  'cancel-in-progress: true',
]) {
  if (!source.includes(expected)) {
    throw new Error(`capacity cleanup is missing contract: ${expected}`);
  }
}
NODE
}

if [[ "${1:-}" == "--expect-unfixed" ]]; then
  set +e
  output="$(check_cleanup_contract 2>&1)"
  status=$?
  set -e
  if [[ $status -eq 0 ]]; then
    echo "expected the unfixed capacity contract to fail" >&2
    exit 1
  fi
  grep -Fq 'capacity leak reproduced' <<<"$output" || {
    printf '%s\n' "$output" >&2
    exit 1
  }
  echo "[repro] capacity leak reproduced: closed wrapper runs retain their concurrency groups"
  exit 0
fi

check_cleanup_contract
echo "[repro] closed merge-queue wrappers cancel stale CI and PR Body capacity"
