# visual-proof

Capture before/after UI screenshots and video for Invoker plans that modify the UI.

## When to use

- Any plan sets `visualProof: true` (i.e. it modifies `packages/ui/`)
- User asks for visual proof, before/after screenshots, or UI regression screenshots
- Reviewing a UI change and wanting to see what changed visually

## Subcommands

The script `scripts/ui-visual-proof.sh` provides four explicit subcommands:

### capture-before

Capture "before" screenshots to `packages/app/e2e/visual-proof/before/`.

```bash
bash scripts/ui-visual-proof.sh capture-before
```

Builds UI and app, runs Playwright tests, saves screenshots and video. Fails fast if build fails.

### capture-after

Capture "after" screenshots to `packages/app/e2e/visual-proof/after/`.

```bash
bash scripts/ui-visual-proof.sh capture-after
```

Same build and capture process as `capture-before`, outputs to `after/` directory.

### compare

Generate diff images and side-by-side video comparison.

```bash
bash scripts/ui-visual-proof.sh compare
```

Requires:
- `before/` and `after/` directories exist with matching `.png` files
- `ffmpeg` installed (for video comparison)
- Optional: ImageMagick `compare` (for per-image pixel diffs)

Outputs to `packages/app/e2e/visual-proof/diff/`.

### embed

Generate markdown with base64-encoded before/after images.

```bash
bash scripts/ui-visual-proof.sh embed
```

Requires `before/` and `after/` directories. Outputs to `packages/app/e2e/visual-proof/EMBED.md`.

## Architecture

### Playwright spec

`packages/app/e2e/visual-proof.spec.ts` defines the UI states to capture. Each test case:
1. Sets up app state via the IPC bridge (`loadPlan`, `startPlan`, etc.)
2. Waits for the UI to reach the desired state
3. Calls `captureScreenshot(page, 'state-name')` which saves a PNG when `CAPTURE_MODE` is set

`captureScreenshot` is defined in `packages/app/e2e/fixtures/electron-app.ts`. It's a no-op unless `CAPTURE_MODE` env var is set.

### Automatic (merge gate)

When `visualProof: true` is set on a plan, the merge gate in `TaskExecutor.runVisualProofCapture()` (in `packages/executors/src/task-executor.ts`) runs the capture subcommands and uploads assets to R2 via `scripts/upload-pr-images.mjs`

### Adding new visual proof states

Edit `packages/app/e2e/visual-proof.spec.ts` and add a test case that calls `captureScreenshot(page, 'my-state')`. The capture subcommands will automatically include it.

Example:

```typescript
test('approval modal', async ({ page }) => {
  await loadPlan(page, PLAN_WITH_MANUAL_APPROVAL);
  await startPlan(page);
  await waitForTaskStatus(page, 'task-1', 'awaiting_approval', 30000);
  await page.locator('[data-testid="rf__node-task-1"]').click();
  await page.getByText('Approve').click();
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

During plan verification (Phase 1b), capture "before" screenshots on the **base branch**:

```bash
bash scripts/ui-visual-proof.sh capture-before
```

### Plan tasks (implementation YAML)

The implementation plan must include two visual-proof-related tasks:

1. **E2E test case task** (`prompt`): Adds a plan-specific test to `visual-proof.spec.ts` that
   captures the exact UI state being changed. Runs in parallel with implementation tasks.

2. **Capture task** (`command`): Captures "after" screenshots. Depends on all
   implementation tasks + the E2E test case task:
   ```bash
   bash scripts/ui-visual-proof.sh capture-after
   ```

## Writing plan-specific E2E test cases

Each UI plan should add a test case to `packages/app/e2e/visual-proof.spec.ts` that targets
the exact UI state being changed.

### Pattern

```typescript
test('<plan-slug> — <state description>', async ({ page }) => {
  await loadPlan(page, MY_PLAN);
  await startPlan(page);
  await waitForTaskStatus(page, 'task-id', 'awaiting_approval', 30000);
  await page.locator('[data-testid="rf__node-task-id"]').click();
  await page.getByText('Approve').click();
  await captureScreenshot(page, '<plan-slug>-<state>');
});
```

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
