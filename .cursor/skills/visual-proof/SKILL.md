# visual-proof

Capture before/after UI screenshots and video for Invoker plans that modify the UI.

## When to use

- Any plan sets `visualProof: true` (i.e. it modifies `packages/ui/`)
- User asks for visual proof, before/after screenshots, or UI regression screenshots
- Reviewing a UI change and wanting to see what changed visually

## Architecture

### Capture script

`scripts/ui-visual-proof.sh` captures screenshots and video for the **current working tree state**. It does not handle git checkouts or before/after orchestration — the caller does that.

```bash
scripts/ui-visual-proof.sh [--label <name>] [--output-dir <dir>] [--spec <file>] [--skip-build]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--label` | `capture` | Subdirectory name under output-dir |
| `--output-dir` | `packages/app/e2e/visual-proof` | Base directory for captures |
| `--spec` | `visual-proof.spec.ts` | Playwright spec file to run |
| `--skip-build` | false | Skip `pnpm build` (when already built) |

Output structure:

```
<output-dir>/<label>/
  ├── empty-state.png
  ├── dag-loaded.png
  ├── task-running.png
  ├── task-complete.png
  ├── task-panel.png
  └── walkthrough.webm
```

### Playwright spec

`packages/app/e2e/visual-proof.spec.ts` defines the UI states to capture. Each test case:
1. Sets up app state via the IPC bridge (`loadPlan`, `startPlan`, etc.)
2. Waits for the UI to reach the desired state
3. Calls `captureScreenshot(page, 'state-name')` which saves a PNG when `CAPTURE_MODE` is set

### How captureScreenshot works

Defined in `packages/app/e2e/fixtures/electron-app.ts`:
- No-op unless `CAPTURE_MODE` env var is set
- Waits for animations to settle (`waitForStableUI`)
- Saves full-page screenshot to `packages/app/e2e/visual-proof/<CAPTURE_MODE>/<name>.png`

### Video capture

Playwright's built-in video recording is enabled via `CAPTURE_VIDEO=1` env var in `packages/app/playwright.config.ts`. The script copies the `.webm` file from `packages/app/e2e/test-results/` to the output directory.

### Prerequisites

- **Linux**: Requires `xvfb-run` (headless X server for Electron)
- **Built app**: The script builds by default; use `--skip-build` to skip

## Workflows

### Manual before/after comparison

```bash
# 1. Capture baseline on the base branch
git checkout main
bash scripts/ui-visual-proof.sh --label before

# 2. Capture after on the feature branch
git checkout feat/my-ui-change
bash scripts/ui-visual-proof.sh --label after

# 3. Compare screenshots in packages/app/e2e/visual-proof/{before,after}/
```

### Automatic (merge gate)

When `visualProof: true` is set on a plan, the merge gate in `TaskExecutor.runVisualProofCapture()` (in `packages/executors/src/task-executor.ts`) automatically:
1. Checks out the base branch → runs the capture script with `--label before`
2. Checks out the feature branch → runs the capture script with `--label after`
3. Uploads assets to R2 via `scripts/upload-pr-images.mjs`
4. Generates markdown with before/after image tables
5. Embeds the markdown in the PR body

### Adding new visual proof states

To capture a new UI state (e.g. approval modal, merge gate):

1. Edit `packages/app/e2e/visual-proof.spec.ts`
2. Add a new test case that sets up the state and calls `captureScreenshot(page, 'my-state')`
3. The capture script will automatically include it

Example:

```typescript
test('approval modal', async ({ page }) => {
  await loadPlan(page, PLAN_WITH_MANUAL_APPROVAL);
  await startPlan(page);
  await waitForTaskStatus(page, 'task-1', 'awaiting_approval', 30000);
  await page.locator('[data-testid="rf__node-task-1"]').click();
  // Open approval modal via task panel
  await page.getByText('Approve').click();
  await expect(page.getByText('Manual Approval Required')).toBeVisible();
  await captureScreenshot(page, 'approval-modal');
});
```

## Key files

| File | Role |
|------|------|
| `scripts/ui-visual-proof.sh` | Capture script (build + Playwright + collect outputs) |
| `packages/app/e2e/visual-proof.spec.ts` | Playwright spec defining UI states to capture |
| `packages/app/e2e/fixtures/electron-app.ts` | `captureScreenshot`, `loadPlan`, `startPlan` helpers |
| `packages/app/playwright.config.ts` | Playwright config (video, screenshot, timeout settings) |
| `packages/executors/src/task-executor.ts` | `runVisualProofCapture()` — merge gate integration |
| `scripts/upload-pr-images.mjs` | Upload captured assets to Cloudflare R2 |
| `scripts/create-pr.mjs` | Create GitHub PR with uploaded visual proof |

## Plan integration (task-level)

UI-change plans must include explicit visual proof tasks, not just the `visualProof: true` flag.

### Before (Phase 1b-visual)

During plan verification (Phase 1b), the agent captures "before" screenshots on the **base branch**:

```bash
git checkout master   # or whatever the base branch is
bash scripts/ui-visual-proof.sh --label before
```

This produces `packages/app/e2e/visual-proof/before/*.png`. These screenshots persist across the plan execution.

### Plan tasks (implementation YAML)

The implementation plan must include two visual-proof-related tasks:

1. **E2E test case task** (`prompt`): Adds a plan-specific test to `visual-proof.spec.ts` that
   captures the exact UI state being changed. Runs in parallel with implementation tasks.

2. **Capture task** (`command`): Builds and captures "after" screenshots. Depends on all
   implementation tasks + the E2E test case task:
   ```
   pnpm --filter @invoker/ui build && pnpm --filter @invoker/app build && bash scripts/ui-visual-proof.sh --label after
   ```

### After (merge gate)

The merge gate's `runVisualProofCapture()` also runs the capture script automatically (separate
from the plan tasks). Both the plan-task screenshots and the merge-gate screenshots are available.

## Writing plan-specific E2E test cases

Each UI plan should add a test case to `packages/app/e2e/visual-proof.spec.ts` that targets
the exact UI state being changed. This ensures the before/after screenshots show the relevant
change, not just generic UI states.

### Pattern

```typescript
test('<plan-slug> — <state description>', async ({ page }) => {
  // 1. Set up the app state via IPC bridge
  await loadPlan(page, MY_PLAN);
  await startPlan(page);

  // 2. Wait for the specific state
  await waitForTaskStatus(page, 'task-id', 'awaiting_approval', 30000);

  // 3. Navigate to the UI being tested
  await page.locator('[data-testid="rf__node-task-id"]').click();
  await page.getByText('Approve').click();

  // 4. Assert the state is correct
  await expect(page.getByText('Expected Label')).toBeVisible();

  // 5. Capture
  await captureScreenshot(page, '<plan-slug>-<state>');
});
```

### Setting up specific app states

Use `loadPlan()` with a custom plan constant. Define it at the top of the spec file or inline:

```typescript
const APPROVAL_PLAN = {
  name: 'Approval test',
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'task-needs-approval',
      description: 'Task requiring manual approval',
      command: 'echo done',
      dependencies: [],
      requiresManualApproval: true,
    },
  ],
};
```

For fix-approval states, you can use `window.invoker` to directly manipulate task state
after loading (e.g. calling internal APIs to set `pendingFixError`).

### Naming convention

Screenshot names: `<plan-slug>-<state>.png`

Examples:
- `fix-approval-labels-modal.png`
- `merge-gate-github-pr.png`
- `modal-overflow-scrolled.png`

### Available helpers

All from `packages/app/e2e/fixtures/electron-app.ts`:

| Helper | Purpose |
|--------|---------|
| `loadPlan(page, plan)` | Load a plan object via IPC and wait for DAG to render |
| `startPlan(page)` | Start plan execution via IPC |
| `waitForTaskStatus(page, taskId, status, timeout)` | Poll until task reaches status |
| `captureScreenshot(page, name)` | Save screenshot (only when `CAPTURE_MODE` is set) |
| `waitForStableUI(page)` | Wait for animations to settle |
| `getTasks(page)` | Get all current tasks via IPC |
