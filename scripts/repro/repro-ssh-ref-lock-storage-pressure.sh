#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}/invoker-repro-ssh-ref-lock-storage-pressure.$$"
REPO="$TMP_ROOT/repo"

cleanup() {
  chmod -R u+w "$TMP_ROOT" 2>/dev/null || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$REPO"
git init -q "$REPO"
git -C "$REPO" config user.name "Invoker Repro"
git -C "$REPO" config user.email "repro@example.com"
printf 'base\n' > "$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" commit -q -m "base"

mkdir -p "$REPO/.git/refs/heads/experiment"
chmod u-w "$REPO/.git/refs/heads/experiment"

set +e
output="$(
  git -C "$REPO" update-ref \
    refs/heads/experiment/wf-storage-pressure/task/g0.t0.a-deadbeef \
    HEAD 2>&1
)"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "FAIL: git update-ref succeeded even though refs/heads/experiment is not writable" >&2
  exit 1
fi

case "$output" in
  *"cannot lock ref"*|*"unable to create directory"*|*"Permission denied"*|*"couldn't write"*)
    echo "PASS: unwritable ref storage reproduces SSH bootstrap ref-lock failure"
    echo "$output" | sed -n '1,6p'
    ;;
  *)
    echo "FAIL: git failed, but not with the expected ref-lock/write error" >&2
    echo "$output" >&2
    exit 1
    ;;
esac

echo "Remote incident evidence to compare against:"
echo "- affected task errors contained: Executor startup failed (ssh) ... couldn't write ... .lock"
echo "- remote_digital_ocean_4 was at 100% disk before cleanup; after cleanup it had free space again"
