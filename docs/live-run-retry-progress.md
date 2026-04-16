# Live `run.sh` / Retry Progress

## Goal

Make the real desktop path acceptable:

1. `./run.sh` launches a real GUI window.
2. After launch, `./scripts/retry-failed-and-pending-all-workflows.sh` does not freeze the UI.
3. The graph is available for interaction immediately after render, including drag interaction.

## What Changed

### Headless ingress and owner path

- Headless commands now use the lightweight client path instead of booting a full Electron process per mutation.
- GUI/standalone owner paths expose `headless.query ui-perf` so the live harness can probe owner health.
- The retry-all script now defaults to bounded submission (`--parallel 1`) instead of an unbounded burst.

### Startup and queue/retry behavior

- GUI startup creates the window before heavy recovery work.
- Workflow retry now refreshes only the targeted workflow instead of refreshing all workflows.
- Startup replay of failed tasks no longer auto-fixes immediately.
- Deferred no-track runnable launches are coalesced per workflow so repeated restart requests do not stack duplicate launches.

### GUI hot-path reductions

- Task output from running work is batched before publishing to the renderer and before persistence writes.
- Default renderer-side `useTasks` delta logging is disabled unless explicitly requested.
- Auto-fix is suppressed for delegated no-track launches so retried failures do not immediately trigger a fix storm on the GUI owner.

### Live validation harness

- Added `scripts/repro/repro-live-run-and-retry-ui.sh`.
- The harness now:
  - launches the real `./run.sh` GUI path
  - waits for the real X11 Invoker window
  - probes startup graph drag interaction
  - runs the retry-all script
  - probes UI responsiveness during the retry burst
- The harness no longer relies only on `headless.query ui-perf`. It now treats real graph drag success as the primary interaction signal.

## Why These Changes Were Made

- The earlier queue/persistence refactor improved correctness, but it moved more work onto GUI startup and retry hot paths.
- The original live failure turned out to be a combination of:
  - startup/replay work on the GUI owner
  - auto-fix churn triggered from replayed/retried failures
  - repeated deferred runnable launches for the same workflow
  - excessive output/delta fanout into the GUI
- The changes above were made to reduce those hot paths without giving up persisted queue truth.

## Current Live Status

### Improved

- `./run.sh` launches a real GUI window.
- The startup graph drag probe succeeds.
- During retry burst, the live graph drag probe still succeeds even when `headless.query ui-perf` temporarily times out.
- The retry-all script now progresses through multiple workflows instead of stalling immediately on the first one.

### Still Not Good Enough

- The GUI process still sits around `100%+` CPU during parts of the retry burst.
- `headless.query ui-perf` can still time out during the first retried task launch window.
- That means the UI is no longer proving “hard frozen”, but the machine-load regression is still real.

## What Is Left

1. Reduce sustained CPU during retried task launch/provisioning on the GUI owner.
2. Tighten the live harness so it fails on both:
   - real interaction loss
   - sustained hot CPU / machine-load regression
3. Add/keep startup interaction expectations:
   - graph visible essentially immediately after render
   - graph draggable immediately on first render
4. Continue treating the live harness as the acceptance gate, not sandbox-only tests.

## Important Interpretation

At this checkpoint, the problem is no longer best described as:

- “the window does not launch”
- or “the UI is completely unresponsive on first retry”

It is now better described as:

- “the graph remains interactable, but retried task launch still drives too much sustained load on the GUI owner”
