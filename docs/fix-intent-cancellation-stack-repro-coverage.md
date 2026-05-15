# Fix Intent Cancellation Stack Repro Coverage

This stack should not carry speculative hardening. Each task either has an executable repro entrypoint or is explicitly justified as regression scope around a demonstrated failure class.

| Workflow task | Proof | Why the complexity is justified |
| --- | --- | --- |
| Step 1: workflow mutation cancellation hardening | `bash scripts/repro/repro-workflow-mutation-cancellation-hardening.sh --expect fixed` (delegates to `repro-fix-intent-cancellation-e2e.sh`) | A queued intent failure is not enough: a running `fix-with-agent` can still complete async work after a hard-preempting `recreate-task`. The E2E repro starts a GUI owner, runs real headless fix with a slow fake Claude process, and races real headless `recreate-task`. |
| Step 2: fix flow lineage guards | `bash scripts/repro/repro-fix-flow-lineage-guards.sh --expect fixed` (delegates to `repro-fix-intent-cancellation-e2e.sh`) | Abort delivery is best effort. Remote/agent work can still return after task lineage changes, so fix finalization must check selected attempt and generation before writing approval state. The E2E repro proves stale fix finalization does not write `awaiting_approval` after recreate-task begins. |
| Step 3: SSH startup lineage guards | `bash scripts/repro/repro-ssh-startup-lineage-guards.sh --expect fixed` (delegates to `repro-ssh-startup-lineage-e2e.sh`) | The demonstrated stale startup failure can reattach an old worktree path and branch to a newer attempt. The E2E repro uses a fake `ssh` binary with the real `SshExecutor`, real GUI owner, and real headless `recreate-task` to prove stale startup metadata and stale failed responses do not land after lineage advances. |
| Step 4: durable failure diagnostics | `bash scripts/repro/repro-durable-failure-diagnostics.sh --expect fixed` (delegates to `repro-durable-failure-diagnostics-e2e.sh`) | This is observability hardening, not state-machine hardening. The E2E repro starts a real owner, runs a real long-lived task, triggers the real owner quit path through a test-only request, and proves durable task output preserves the shutdown diagnostic and recent concrete output marker before the terminal row collapses to `Application quit`. |
| Step 5: repro and regression verification | `bash scripts/repro/repro-fix-intent-cancellation-stack.sh --expect fixed` and `scripts/test-suites/required/23-fix-intent-repros.sh` | The terminal workflow task is justified only as an integration gate. It bundles the focused repros plus the existing queue-authority, stale-late-completion, and overload churn repros before the repo-wide regression suite runs. |

The broader stack wrapper also runs:

- `scripts/repro/repro-recreate-task-blocked-by-running-workflow-mutation.sh`
- `scripts/repro/repro-fix-intent-cancellation-e2e.sh`
- `scripts/repro/repro-ssh-startup-lineage-e2e.sh`
- `scripts/repro/repro-durable-failure-diagnostics-e2e.sh`
- `scripts/repro/repro-fix-intent-cancellation-and-stale-ssh-metadata.sh`
- `scripts/repro/repro-stale-late-completion-after-reset.sh`
- `scripts/repro/repro-same-workflow-tracked-fix-vs-recreate.sh`
- `scripts/repro/repro-owner-restart-loop-during-tracked-recreate-task.sh`

Those remain useful as end-to-end and overload evidence, but the step-specific scripts above are the canonical proof for the hardening tasks themselves.
