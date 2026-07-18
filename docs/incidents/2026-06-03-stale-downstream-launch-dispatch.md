# Stale Downstream Launch Dispatch After Dependency Reset

Date: 2026-06-03

## Summary

A downstream launch dispatch row can survive after one of its prerequisites
reverts from `completed` to `pending`. If the old dispatch row is later leased,
the downstream task can run against an invalid DAG snapshot.

This was observed with the camera-lock review gate:

- Upstream verification task:
  `wf-1780385791355-3/verify-viewport-camera-tests`
- Downstream review gate:
  `__merge__wf-1780385791355-3`
- Production log evidence showed the merge node running while its dependency was
  pending:
  `merge node "__merge__wf-1780385791355-3" status=running deps=[wf-1780385791355-3/verify-viewport-camera-tests=pending] hasDep=false`

The root issue is not the review gate failure itself. The review gate should not
have started after its prerequisite reverted to `pending`.

## Repro

Focused repro:

```sh
pnpm --filter @invoker/data-store exec vitest run \
  --reporter verbose \
  --exclude '**/node_modules/**' \
  src/__tests__/stale-downstream-launch-dispatch-repro.test.ts
```

Bash repro using a temporary SQLite DB:

```sh
bash scripts/repro/repro-stale-downstream-launch-dispatch.sh --expect-issue
```

The repro seeds this sequence:

1. Save an upstream verification task as `completed`, generation 1.
2. Save a dependent merge task as `pending`, generation 1.
3. Enqueue a launch dispatch for the merge task at generation 1.
4. Reset the upstream verification task to `pending`, generation 2.
5. Reset the merge task to `pending`, generation 2, with a new selected attempt.
6. Call `claimLaunchDispatchAtomic`.

Current behavior leases the stale generation-1 merge dispatch:

```text
task rows:
id                                     status   dependencies                             selected_attempt_id                              execution_generation
__merge__wf-stale-downstream-dispatch  pending  ["wf-stale-downstream-dispatch/verify"]  __merge__wf-stale-downstream-dispatch-attempt-2  2
wf-stale-downstream-dispatch/verify    pending  []                                       wf-stale-downstream-dispatch/verify-attempt-2    2

launch dispatch rows:
id  task_id                                attempt_id                                       state   generation  dispatch_owner  leased_at
1   __merge__wf-stale-downstream-dispatch  __merge__wf-stale-downstream-dispatch-attempt-1  leased  1           repro-owner     2026-06-03T00:02:00.000Z
```

Expected fixed behavior: the old dispatch is abandoned or skipped, and no
downstream lease is returned until the dependency is completed again and a fresh
dispatch exists for the current downstream attempt.

## Root Cause

`task_launch_dispatch` readiness is established when the scheduler enqueues a
row. `claimLaunchDispatchAtomic` currently leases `state = 'enqueued'` rows by
priority and id. It does not prove that the row still matches the authoritative
task snapshot at lease time.

The missing checks are:

- dispatch `attempt_id` still equals the task `selected_attempt_id`
- dispatch `generation` still equals the task `execution_generation`
- the task is still launchable
- dependencies are still satisfied
- reset/retry/recreate paths abandoned downstream dispatch rows that were
  created from an older graph snapshot

`resetSubgraphToPending` clears queued scheduler entries, but launch dispatch
rows are durable outbox rows and are not invalidated there.

## Fix Plan

1. Add a persistence helper to abandon active launch dispatches for a set of
   task ids.

   Candidate API:

   ```ts
   abandonLaunchDispatchesForTasks(taskIds, reason, nowIso?)
   ```

   It should mark `enqueued`, `leased`, and `acknowledged` rows as `abandoned`,
   clear owner/fence fields, set terminal timestamps and `last_error`, and emit
   a launch-dispatch invalidation event.

2. Call that helper from `resetSubgraphToPending` for every affected task in the
   reset subgraph. This covers upstream retry, task recreate, workflow recreate,
   rebase, fix approval, and fix rejection paths that replace selected attempts.

3. Add lease-time validation to `claimLaunchDispatchAtomic` before returning a
   row. At minimum, a row is leaseable only when:

   - the joined task exists
   - task status is `pending`
   - dispatch attempt matches `tasks.selected_attempt_id`
   - dispatch generation matches `tasks.execution_generation`

   Rows that fail those checks should be abandoned and skipped.

4. Add a second readiness check in the active launch dispatcher before handing a
   lease to the task runner. It should reload the task graph and refuse to launch
   when local dependencies are not currently satisfied. This protects against
   stale leases even if a future reset path misses the explicit invalidation
   call.

5. Release execution resource leases for invalidated downstream dispatches. Use
   the existing execution resource lease release path so an abandoned launch
   dispatch cannot keep SSH or pool capacity reserved.

6. Convert the repros into passing regression checks:

   ```sh
   pnpm --filter @invoker/data-store exec vitest run \
     --reporter verbose \
     --exclude '**/node_modules/**' \
     src/__tests__/stale-downstream-launch-dispatch-repro.test.ts

   bash scripts/repro/repro-stale-downstream-launch-dispatch.sh --expect-fixed
   ```

7. Add focused coverage around the integration points:

   - `SQLiteAdapter.claimLaunchDispatchAtomic` skips stale attempt/generation
     rows.
   - `LaunchDispatcher` abandons an active lease and does not call
     `executeTask` when dependencies are no longer satisfied.
   - orchestrator reset/retry paths abandon launch dispatches for descendants
     and merge nodes.

No schema migration is required because `task_launch_dispatch.state` already
supports `abandoned`. An index on `(task_id, state)` is optional if the
invalidation query needs help at scale.
