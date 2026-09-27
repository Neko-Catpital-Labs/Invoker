You are working in a local checkout of the Invoker monorepo. Dependencies are already installed; there is no network publishing, no git remote, and no Invoker instance for you to use.

Task: the API server and web surfaces go through `WorkflowMutationFacade` (`packages/app/src/workflow-mutation-facade.ts`) for task mutations, but changing a task's pool is only reachable by calling `CommandService.editTaskPool` directly. Add an `editTaskPool(taskId: string, poolId: string)` method to `WorkflowMutationFacade` that returns a `MutationResult`, so those surfaces can edit a task's pool through the facade with the same guarantees the facade already gives its other task-level mutations.

Constraints:
- Change only files under `packages/app/src/`. Do not change callers, other packages, package manifests, lockfiles, or test configuration.
- Add or update unit tests for the new method, and run the relevant tests with `pnpm test` or `pnpm exec vitest run <file>` from `packages/app`.
- Leave your changes in the working tree (committing is optional). Do not push, publish, or contact any external service.

When you are done, reply with a short summary of what you changed.
