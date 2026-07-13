#!/usr/bin/env bash
# Reproduces the "blank terminal" bug: when node-pty's prebuilt spawn-helper
# loses its exec bit (which is how node-pty@1.1.0 ships in its npm tarball),
# double-clicking a task in the GUI opened no terminal session and showed no
# error — the spawn failure rejected the IPC promise and the renderer dropped
# it silently.
#
# This script strips the exec bit from the repo's spawn-helper (restoring it
# on exit), launches the real Electron app via the Playwright e2e harness,
# double-clicks a completed task node in the DAG, and then requires that ONE
# of the two acceptable outcomes happened:
#   - a terminal session actually opened, or
#   - a visible error alert was shown.
#
# Exit 1 ("BUG REPRODUCED") means neither happened: the blank terminal.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPEC_FILE="$ROOT_DIR/packages/app/e2e/tmp-repro-blank-terminal.spec.ts"

PLATFORM_ARCH="$(node -p 'process.platform + "-" + process.arch')"
HELPERS=()
while IFS= read -r helper; do
  HELPERS+=("$helper")
done < <(find "$ROOT_DIR/node_modules/.pnpm" -path "*node-pty*/prebuilds/$PLATFORM_ARCH/spawn-helper" 2>/dev/null)

if [ "${#HELPERS[@]}" -eq 0 ]; then
  echo "No node-pty spawn-helper found under $ROOT_DIR/node_modules — run pnpm install first." >&2
  exit 2
fi

cleanup() {
  local ec=$?
  rm -f "$SPEC_FILE"
  for helper in "${HELPERS[@]}"; do
    chmod +x "$helper" || true
  done
  return "$ec"
}
trap cleanup EXIT

echo "Stripping exec bit from:"
for helper in "${HELPERS[@]}"; do
  echo "  $helper"
  chmod a-x "$helper"
done

cat > "$SPEC_FILE" <<'TS'
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  E2E_REPO_URL,
  expect,
  injectTaskStates,
  loadPlan,
  test,
} from './fixtures/electron-app.js';

const PLAN = {
  name: 'Blank Terminal Repro',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'shell-task',
      description: 'Completed task whose terminal restores a plain shell',
      command: 'echo unused',
      dependencies: [],
    },
  ],
};

test('double-clicking a task opens a terminal session or shows a visible error', async ({ page, testDir }) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    dialog.dismiss().catch(() => {});
  });

  await loadPlan(page, PLAN);
  const workspacePath = path.join(testDir, 'shell-task-workspace');
  mkdirSync(workspacePath, { recursive: true });

  await injectTaskStates(page, [
    {
      taskId: 'shell-task',
      changes: {
        status: 'completed',
        config: { runnerKind: 'worktree' },
        execution: {
          workspacePath,
          completedAt: new Date('2025-01-01T00:00:00.000Z'),
        },
      },
    },
  ]);

  const taskNode = page
    .getByTestId('selected-workflow-mini-dag')
    .locator('.react-flow__node[data-testid$="shell-task"]')
    .first();
  const box = await taskNode.boundingBox();
  if (!box) throw new Error('shell-task node has no bounding box');
  await taskNode.locator('> div').dispatchEvent('dblclick', {
    bubbles: true,
    cancelable: true,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });

  // Give the renderer time to either open a session tab or alert.
  const deadline = Date.now() + 10000;
  let sessionOpened = false;
  while (Date.now() < deadline) {
    sessionOpened = await page
      .getByTestId('terminal-session-command')
      .first()
      .isVisible()
      .catch(() => false);
    if (sessionOpened || dialogs.length > 0) break;
    await page.waitForTimeout(250);
  }

  const drawerVisible = await page
    .getByTestId('terminal-drawer-body')
    .isVisible()
    .catch(() => false);
  console.log(
    `[repro] sessionOpened=${sessionOpened} alerts=${JSON.stringify(dialogs)} drawerVisible=${drawerVisible}`,
  );

  expect(
    sessionOpened || dialogs.length > 0,
    'Double-click produced neither a terminal session nor a visible error — blank terminal.',
  ).toBeTruthy();
});
TS

echo
echo "Building UI and app..."
(cd "$ROOT_DIR" && pnpm --filter @invoker/ui build >/dev/null && pnpm --filter @invoker/app build >/dev/null)

echo "Running GUI repro (real Electron app, real double-click)..."
set +e
(cd "$ROOT_DIR/packages/app" && pnpm run test:e2e e2e/tmp-repro-blank-terminal.spec.ts)
ec=$?
set -e

echo
if [ "$ec" -ne 0 ]; then
  echo "BUG REPRODUCED: double-click opened no terminal session and showed no error (blank terminal)."
  exit 1
fi
echo "No blank terminal: double-click surfaced a terminal session or a visible error alert."
