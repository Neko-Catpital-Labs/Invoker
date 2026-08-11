const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

export function printHeadlessUsage(): void {
  process.stdout.write(`${BOLD}invoker${RESET} — Headless workflow runner (Electron)

${BOLD}Usage:${RESET}  electron dist/main.js --headless <command> [args...]

${BOLD}Query${RESET} (read-only, all support --output text|label|json|jsonl):
  query workflows [--status S] [--output F]          List all saved workflows
  query workflow <workflowId> [--output F]           Show one workflow
  query tasks [--workflow <id>|<workflowId>] [--status S]
                                                      Show task states (latest workflow by default)
    [--no-merge] [--output F]
  query task <taskId> [--output F]                    Print single task status
  query queue [--output F]                            Show queue status
  query review-gate <prNumber|prUrl> [--output F]    Resolve a PR back to its Invoker workflow
  query action-graph [--output F]                     Print action graph source-of-truth snapshot
  query audit <taskId> [--output F]                   Print event history
  query session <taskId>                              Print agent session messages
  query worker-actions [--workflow <id>] [--status S] [--decision act|skip]
                                                      List durable worker action rows (all workers)
  query worker-decisions [--workflow <id>] [--decision act|skip] [--reason <substr>]
                                                      Show what each worker decided: submitted vs skipped, and why
  query ui-perf [--output F] [--reset]               Print live UI perf stats
  query stats [--output F]                           Aggregate stats across all workflows
  query execution-leases [--output F]               List live SSH/host execution resource leases

${BOLD}Execute:${RESET}
  watch [<workflowId>]                                Watch workflow status until settled or Ctrl-C
  run <plan.yaml>                                     Load and execute plan
  start-ready [--dry-run] [--recreate-failed] [--recreate-failed-and-pending] [--recreate-failed-pending-and-running] [--recreate-all]
              [--fresh-base-failed] [--fresh-base-failed-and-pending] [--fresh-base-failed-pending-and-running] [--fresh-base-all] [--no-track]
                                                      Start pending work that is ready to execute
                                                      Fresh-base flags recreate selected workflows from a refreshed base
  resume <id>                                         Resume incomplete workflow
  retry <workflowId>                                  Retry workflow: rerun failed, keep completed
  retry-task <taskId>                                 Retry a single failed/stuck task
  recreate <workflowId>                                Recreate workflow: wipe all state, new generation
  recreate-task <taskId>                               Recreate task + downstream (task-scoped reset)
  recreate-downstream <taskId>                         Recreate downstream of task only (target preserved)
  fork-workflow <workflowId>                          Fork a live workflow into a new branched workflow (Step 14)
  detach-workflow <workflowId> <upstreamWorkflowId>  Detach one upstream workflow and void downstream to pending
  attach-workflow <workflowId> <upstreamWorkflowId> [--gate-policy P] [--task-id T] [--force]
                                                     Attach a workflow to an upstream's gate (new or previously detached)
  rebase-retry <workflowId|mergeTaskId|taskId>        Refresh pool base, then retry incomplete work
  rebase-recreate <workflowId|mergeTaskId|taskId>     Refresh pool base, then recreate workflow
  repair-review-gate-ci <prNumber|prUrl>              Queue CI repair for one mapped review-gate PR
  check-pr-status [taskId]                            Force an immediate merge-gate PR-status recheck
  fix <taskId> [claude|codex]                         Fix a failed task (default: claude)

${BOLD}Respond:${RESET}
  approve <taskId>                                    Approve a task
  reject <taskId> [reason]                            Reject a task
  input <taskId> <text>                               Provide input to task
  select <taskId> <experimentId>                      Select winning experiment

${BOLD}Configure:${RESET}
  install-skills [install|update|reinstall]          Install bundled Invoker AI helpers
  set command <taskId> <cmd>                          Edit task command and re-run
  set prompt <taskId> <text>                          Edit task prompt and re-run
  set pool <taskId> <type> [poolMemberId]           Change execution pool (worktree|docker|ssh)
  set task-pool <taskId> <poolId>                     Change execution pool by poolId (from executionPools config)
  set agent <taskId> <agent>                          Change execution agent (claude|codex|omp)
  set merge-mode <workflowId> <mode>                  manual | automatic | external_review
  set fix-prompt <taskId> <text>                      Update fix-session prompt and retry
  set fix-context <taskId> <text>                     Update fix-session context and retry
  set gate-policy <taskId> <wfId> [depTaskId] <policy>
                                                      policy: completed | review_ready | ci_failed
  set workflow <workflowId> <fieldPath> <value>      Safely update workflow metadata/config
  set task <taskId> <fieldPath> <value>              Safely update task metadata/config
  migrate-compat                                     Normalize persisted compatibility workflow/task state

${BOLD}Lifecycle:${RESET}
  cancel <taskId>                                     Cancel task + all downstream
  cancel-workflow <workflowId>                        Cancel all active tasks in a workflow
  delete-task <taskId>                                 Delete one task and retarget dependents
  delete <workflowId>                                  Delete a single workflow
  delete-all                                           Delete all workflows (requires INVOKER_ALLOW_DELETE_ALL=1)
  open-terminal <taskId>                              Open OS terminal for a task
  slack                                               Start Slack bot (long-running)
  worker [kind|list|status]                           Run/list registry worker kinds (autofix scans failed tasks)

${BOLD}Options:${RESET}
  --wait-for-approval    Keep running until PR approval (use with 'run' or 'resume')
  --no-track             Submit and return immediately after printing Workflow ID
  --do-not-track         Alias for --no-track
`);
}
