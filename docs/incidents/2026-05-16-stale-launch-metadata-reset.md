# Stale Launch Metadata After Reset

Date: 2026-05-16

## Summary

Resetting workflow tasks to `pending` could preserve stale launch metadata from a previous attempt. A dependent task could then look like `pending + launching` even though its new selected attempt was only a reset-created pending row and its upstream dependencies were not satisfied.

The app poller also treated `pending + execution.phase === "launching"` as launch-stall eligible without checking whether the selected attempt had actually been claimed for launch. That allowed stale reset metadata to synthesize a launch-stall failure before the DAG was ready to run the task.

## Why We Missed It

- Existing stale launch metadata coverage focused on terminal SQLite compatibility cleanup, not reset-created pending tasks.
- Reset events were verified without asserting DAG dependency invariants for dependent tasks left pending behind unsatisfied upstream work.
- A later no-workspace auto-fix failure made the earlier synthetic launch-stall failure harder to see in production logs.
- Reset paths used different payloads from `retryTask`; `retryTask` already cleared `execution.phase`, `execution.launchStartedAt`, and `execution.launchCompletedAt`, while `retryWorkflow`, `recreateTask`, and `recreateWorkflow` did not.

## Fix

- Reset-to-pending paths now explicitly clear launch phase and launch timestamps.
- The app poller only treats `pending + launching` as launch-stall eligible when the selected attempt is a current launch claim (`claimed` or `running` with `claimedAt`).
- Focused repro scripts and tests cover both the reset cleanup and the poller guard.
