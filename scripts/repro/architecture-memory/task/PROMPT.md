You are working in a checkout of the Invoker monorepo. Dependencies are already
installed. There is no network access you need and no remote to publish to: make
local edits and run local tests only.

## Background

The Invoker desktop app funnels every workflow and task mutation from its
entrypoints (`packages/app/src/api-server.ts`, `packages/app/src/headless-shared.ts`,
`packages/app/src/main.ts`) through `WorkflowMutationFacade` in
`packages/app/src/workflow-mutation-facade.ts`.

`CommandService.closeIdleTask(envelope)` (in `packages/workflow-core/src/command-service.ts`)
closes a single idle task and returns that task's new state. The facade does not
expose it yet, so `packages/app/src/headless-approve-delete.ts` reaches past the
facade and calls `CommandService` directly.

## Your task

Add a public `closeIdleTask(taskId: string): Promise<MutationResult>` method to
`WorkflowMutationFacade`.

1. It must route the mutation through `CommandService.closeIdleTask`, using a
   command envelope whose command id is `facade.close-idle-task` and whose scope
   is `task`, carrying `{ taskId }` as the payload.
2. It must give this mutation the same task-scoped lifecycle that every other
   task-scoped mutation on this class already gets.
3. A failed `CommandResult` from `CommandService` must surface as a rejected
   promise, not a resolved `MutationResult`.

Only edit `packages/app/src/workflow-mutation-facade.ts`. Do not add or edit any
test file, and do not change any other package.

## Checking your work

From `packages/app`:

```
./node_modules/.bin/vitest run src/__tests__/workflow-mutation-facade.test.ts src/__tests__/parity-regression.test.ts
```

From the repository root:

```
./node_modules/.bin/tsc --noEmit -p tsconfig.typecheck.json
```

Both must stay green. Stop when you are done; do not commit.
