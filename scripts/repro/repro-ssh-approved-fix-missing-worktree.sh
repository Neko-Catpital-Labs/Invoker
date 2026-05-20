#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-ssh-approved-fix-missing-worktree.sh --expect issue|fixed

What it proves:
  The approved-fix publish path can race with recreate cleanup:
    1. publish snapshots the task's persisted workspacePath
    2. recreate-style cleanup removes that worktree through RepoPool.release()
    3. publish runs the generated record-and-push script against the stale path
    4. cd "$WT" fails with "No such file or directory"

This is a real concurrent repro using RepoPool and buildRecordAndPushScript,
not a manual rm -rf of the worktree.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "issue" && "$EXPECTATION" != "fixed" ]]; then
  echo "--expect must be issue or fixed" >&2
  usage >&2
  exit 2
fi

command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required" >&2; exit 2; }

cd "$ROOT_DIR"

TEST_FILE="$ROOT_DIR/packages/execution-engine/src/__tests__/__tmp_repro_ssh_approved_fix_missing_worktree.test.ts"
cleanup() {
  rm -f "$TEST_FILE"
}
trap cleanup EXIT

cat >"$TEST_FILE" <<'TS'
import { describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoPool } from '../repo-pool.js';
import { buildRecordAndPushScript } from '../ssh-git-exec.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('repro: approved-fix publish missing worktree race', () => {
  it('publishes using a persisted worktree after recreate cleanup removed it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoker-approved-fix-wt-race-'));
    try {
      const source = join(root, 'source');
      const cacheDir = join(root, 'cache');
      const worktreeBaseDir = join(root, 'worktrees');

      execSync(`git init -b master ${JSON.stringify(source)}`, { stdio: 'ignore' });
      writeFileSync(join(source, 'README.md'), 'seed\n');
      execSync('git add README.md', { cwd: source, stdio: 'ignore' });
      execSync('git -c user.name="Seed" -c user.email="seed@example.invalid" commit -m seed', {
        cwd: source,
        stdio: 'ignore',
      });

      const pool = new RepoPool({ cacheDir, worktreeBaseDir, maxWorktrees: 5 });
      const acquired = await pool.acquireWorktree(source, 'experiment/race-task');

      const persistedWorkspacePath = acquired.worktreePath;
      const persistedBranch = acquired.branch;
      writeFileSync(join(persistedWorkspacePath, 'fix.txt'), 'approved fix\n');

      const publishScript = buildRecordAndPushScript({
        worktreePath: persistedWorkspacePath,
        branch: persistedBranch,
        commitMessageChanges: 'approved fix',
        commitMessageEmpty: 'approved empty fix',
        gitUserName: 'Invoker Repro',
        gitUserEmail: 'invoker-repro@example.invalid',
      });

      const publish = (async () => {
        await sleep(75);
        try {
          execFileSync('bash', ['-lc', publishScript], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return { ok: true, output: '' };
        } catch (err: any) {
          return {
            ok: false,
            output: `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`,
          };
        }
      })();

      const recreateCleanup = (async () => {
        await sleep(10);
        await acquired.release();
      })();

      const [publishResult] = await Promise.all([publish, recreateCleanup]);

      expect(existsSync(persistedWorkspacePath)).toBe(false);
      expect(publishResult.ok).toBe(false);
      expect(publishResult.output).toMatch(/cd: .*No such file or directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
TS

set +e
publish_output="$(
  pnpm --dir packages/execution-engine exec vitest run \
    "$TEST_FILE" \
    -t "publishes using a persisted worktree after recreate cleanup removed it" \
    2>&1
)"
publish_status=$?
set -e

if [[ "$publish_status" -eq 0 ]] && grep -Fq "approved-fix publish missing worktree race" <<<"$publish_output"; then
  OBSERVED="issue"
else
  OBSERVED="fixed"
fi

echo "$publish_output"
echo "publish_status=$publish_status"
echo "observed=$OBSERVED"
echo "expected=$EXPECTATION"

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  exit 1
fi

echo "==> repro matched expectation"
