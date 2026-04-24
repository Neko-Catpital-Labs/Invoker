#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""
KEEP_ARTIFACTS=0
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-120}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-orphan-worktree-path-collision.sh --expect bug|fixed [--keep-artifacts]

What it proves:
  1. A directory can exist at the target worktree path while NOT being registered in
     `git worktree list --porcelain` ("leaked/orphan path").
  2. Raw `git worktree add -B` fails in that state with `already exists`.
  3. The current RepoPool implementation either repairs that orphan path (`fixed`)
     or still fails with the same error (`bug`).

Exit codes:
  0  observed behavior matches --expect
  1  observed behavior does not match --expect
  2  repro setup or assertion was invalid / unexpected
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --keep-artifacts)
      KEEP_ARTIFACTS=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "repro: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "bug" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: --expect requires bug|fixed" >&2
  usage >&2
  exit 2
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-orphan-worktree.XXXXXX")"
FIXTURE_REPO="$TMP_DIR/fixture-repo"
CACHE_DIR="$TMP_DIR/cache"
WORKTREE_BASE="$TMP_DIR/worktrees"
HELPER_TEST="$(mktemp "$ROOT_DIR/packages/execution-engine/src/__tests__/tmp-repro-orphan-worktree.XXXXXX.test.ts")"
RAW_STDERR="$TMP_DIR/raw-git.stderr.log"
RAW_STDOUT="$TMP_DIR/raw-git.stdout.log"
VITEST_LOG="$TMP_DIR/vitest.log"

cleanup() {
  rm -f "$HELPER_TEST" 2>/dev/null || true
  if [[ "$KEEP_ARTIFACTS" != "1" ]]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

die() {
  echo "repro: $*" >&2
  exit 2
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_cmd git
require_cmd pnpm
require_cmd timeout
require_cmd sha256sum

mkdir -p "$CACHE_DIR" "$WORKTREE_BASE"

git init "$FIXTURE_REPO" >/dev/null 2>&1
git -C "$FIXTURE_REPO" config user.email "repro@example.com"
git -C "$FIXTURE_REPO" config user.name "Invoker Repro"
printf 'seed\n' > "$FIXTURE_REPO/README.md"
git -C "$FIXTURE_REPO" add README.md >/dev/null 2>&1
git -C "$FIXTURE_REPO" commit -m "seed repro fixture" >/dev/null 2>&1

REPO_URL="$FIXTURE_REPO"
REPO_HASH="$(printf '%s' "$REPO_URL" | sha256sum | awk '{print $1}' | cut -c1-12)"
BRANCH="experiment/repro-orphan-worktree-path-collision"
SANITIZED_BRANCH="${BRANCH//\//-}"
MIRROR="$CACHE_DIR/$REPO_HASH"
WORKTREE_PATH="$WORKTREE_BASE/$REPO_HASH/$SANITIZED_BRANCH"

echo "==> repro: fixture repo"
echo "repo_url      : $REPO_URL"
echo "repo_hash     : $REPO_HASH"
echo "mirror        : $MIRROR"
echo "branch        : $BRANCH"
echo "worktree_path : $WORKTREE_PATH"

git clone "$REPO_URL" "$MIRROR" >/dev/null 2>&1

mkdir -p "$WORKTREE_PATH"
printf 'orphaned directory\n' > "$WORKTREE_PATH/leaked.txt"

echo "==> repro: prove orphan state"
if [[ ! -e "$WORKTREE_PATH" ]]; then
  die "expected worktree path to exist: $WORKTREE_PATH"
fi

if git -C "$MIRROR" worktree list --porcelain | grep -F "$WORKTREE_PATH" >/dev/null 2>&1; then
  die "target path is registered as a git worktree; expected an unregistered orphan path"
fi

echo "filesystem_exists : yes"
echo "git_registered    : no"

echo "==> repro: raw git mechanism"
set +e
git -C "$MIRROR" worktree add -B "$BRANCH" "$WORKTREE_PATH" HEAD >"$RAW_STDOUT" 2>"$RAW_STDERR"
RAW_STATUS=$?
set -e

if [[ "$RAW_STATUS" -eq 0 ]]; then
  die "raw git unexpectedly succeeded; expected 'already exists' failure"
fi

if ! grep -q "already exists" "$RAW_STDERR"; then
  echo "raw git stderr:" >&2
  cat "$RAW_STDERR" >&2 || true
  die "raw git failed, but not with the expected 'already exists' message"
fi

echo "raw_git_status   : $RAW_STATUS"
echo "raw_git_failure  : $(tr '\n' ' ' < "$RAW_STDERR" | sed 's/  */ /g')"

cat > "$HELPER_TEST" <<EOF
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { RepoPool } from '${ROOT_DIR}/packages/execution-engine/src/repo-pool.ts';

describe('orphan worktree path collision repro', () => {
  it('repairs or surfaces the leaked target path deterministically', async () => {
    const pool = new RepoPool({
      cacheDir: '${CACHE_DIR}',
      worktreeBaseDir: '${WORKTREE_BASE}',
    });
    const acquired = await pool.acquireWorktree('${REPO_URL}', '${BRANCH}');
    expect(acquired.worktreePath).toBe('${WORKTREE_PATH}');
    expect(existsSync('${WORKTREE_PATH}/.git')).toBe(true);
    const currentBranch = execSync('git branch --show-current', {
      cwd: acquired.worktreePath,
      encoding: 'utf8',
    }).trim();
    expect(currentBranch).toBe('${BRANCH}');
    await pool.destroyAll();
  });
});
EOF

echo "==> repro: current RepoPool behavior"
set +e
timeout "$TIMEOUT_SECONDS" \
  pnpm --filter @invoker/execution-engine exec vitest run "$HELPER_TEST" \
  >"$VITEST_LOG" 2>&1
VITEST_STATUS=$?
set -e

OBSERVED=""
if [[ "$VITEST_STATUS" -eq 0 ]]; then
  OBSERVED="fixed"
else
  if grep -q "already exists" "$VITEST_LOG"; then
    OBSERVED="bug"
  else
    echo "==> repro: unexpected vitest failure"
    cat "$VITEST_LOG" >&2 || true
    die "vitest failed, but not with the orphan-path collision signature"
  fi
fi

echo "observed      : $OBSERVED"
echo "expected      : $EXPECTATION"

echo "==> repro summary"
echo "orphan_path        : $WORKTREE_PATH"
echo "mirror_registered  : no"
echo "raw_git_already_exists : yes"
echo "repo_pool_observed : $OBSERVED"
echo "artifacts          : $TMP_DIR"

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  echo "==> repro mismatch"
  cat "$VITEST_LOG" >&2 || true
  exit 1
fi

echo "==> repro matched expectation"
exit 0
