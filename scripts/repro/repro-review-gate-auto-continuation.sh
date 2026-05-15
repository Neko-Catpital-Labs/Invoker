#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
base_ref="${1:-upstream/master}"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/invoker-review-gate-auto-continuation.XXXXXX")"
before_worktree="$tmp_root/before"

cleanup() {
  git -C "$repo_root" worktree remove --force "$before_worktree" >/dev/null 2>&1 || true
  rm -rf "$tmp_root"
}
trap cleanup EXIT

echo "[repro] Creating before-fix worktree at $base_ref"
git -C "$repo_root" worktree add --detach "$before_worktree" "$base_ref" >/dev/null

cat > "$tmp_root/repro.patch" <<'PATCH'
diff --git a/packages/execution-engine/src/__tests__/task-runner.test.ts b/packages/execution-engine/src/__tests__/task-runner.test.ts
index 16b32712..961a29a7 100644
--- a/packages/execution-engine/src/__tests__/task-runner.test.ts
+++ b/packages/execution-engine/src/__tests__/task-runner.test.ts
@@ -4286,6 +4286,10 @@ console.log(JSON.stringify(out));
       });
 
       it('merged status with workspacePath triggers orchestrator.approve', async () => {
+        const downstream = makeTask({
+          id: 'downstream-after-refresh',
+          status: 'running',
+        });
         const allTasks = [
           makeTask({
             id: 'merge-approved',
@@ -4300,7 +4304,7 @@ console.log(JSON.stringify(out));
         const orchestrator = {
           getTask: (id: string) => allTasks.find(t => t.id === id),
           getAllTasks: () => allTasks,
-          approve: vi.fn(),
+          approve: vi.fn().mockResolvedValue([downstream]),
         };
         const persistence = { updateTask: vi.fn() };
         const mergeGateProvider = {
@@ -4318,6 +4322,7 @@ console.log(JSON.stringify(out));
           cwd: '/runner-base-cwd',
           mergeGateProvider: mergeGateProvider as any,
         });
+        const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);
 
         await executor.checkMergeGateStatuses();
 
@@ -4329,6 +4334,7 @@ console.log(JSON.stringify(out));
           execution: { reviewStatus: 'Merged' },
         });
         expect(orchestrator.approve).toHaveBeenCalledWith('merge-approved');
+        expect(executeTasks).toHaveBeenCalledWith([downstream]);
       });
 
       it('approved-but-open PR updates persistence without completing the gate', async () => {
PATCH

echo "[repro] Installing dependencies in before-fix worktree"
pnpm -C "$before_worktree" install --frozen-lockfile >/dev/null

echo "[repro] Injecting failing assertion into before-fix worktree"
git -C "$before_worktree" apply "$tmp_root/repro.patch"

before_log="$tmp_root/before.log"
echo "[repro] Running before-fix repro. This is expected to fail."
set +e
pnpm -C "$before_worktree" --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner.test.ts \
  -t 'merged status with workspacePath triggers orchestrator.approve' \
  >"$before_log" 2>&1
before_status=$?
set -e

if [[ "$before_status" -eq 0 ]]; then
  echo "[repro] ERROR: before-fix repro unexpectedly passed"
  cat "$before_log"
  exit 1
fi

if ! grep -q 'Number of calls: 0' "$before_log"; then
  echo "[repro] ERROR: before-fix failure did not prove missing downstream dispatch"
  cat "$before_log"
  exit 1
fi

echo "[repro] Before-fix failure confirmed: approve returned downstream work, executeTasks was not called."

echo "[repro] Installing dependencies in fixed worktree"
pnpm -C "$repo_root" install --frozen-lockfile >/dev/null

after_log="$tmp_root/after.log"
echo "[repro] Running fixed-branch regression. This must pass."
pnpm -C "$repo_root" --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner.test.ts \
  -t 'merged status with workspacePath triggers orchestrator.approve' \
  >"$after_log" 2>&1

echo "[repro] Fixed-branch pass confirmed."
