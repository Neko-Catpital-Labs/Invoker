/**
 * Duplicated from `scripts/e2e-regression-watch.mjs`'s `MARKER_PREFIX` — that
 * file is not importable from this TS package (plain .mjs script, no build
 * step shared with @invoker/execution-engine). Keep the two in sync by hand;
 * `idle-task-cleanup-policy.test.ts` pins the literal value.
 *
 * The marker lives on the *workflow's* description (the plan's top-level
 * `description:`, set from `ci-regression-watch.workflow.yaml`), not on any
 * individual task — confirmed against `liveQueryHasNonTerminalWork`
 * (`scripts/e2e-regression-watch.mjs:885-889`), which checks `w.description`
 * on `query workflows` rows.
 */
const E2E_REPAIR_MARKER = 'invoker-ci-regression-watch: first-bad-sha=';

const ADMIN_BYPASS_REPAIR_NAME_PATTERN = /^repair-pr-\d+-.+$/;

/** Matches the `repair-pr-<num>-<fingerprint>` plans filed by `scripts/cron-pr-orphan-repair.sh`. */
export function isAdminBypassRepairTask(workflowName: string | undefined): boolean {
  return typeof workflowName === 'string' && ADMIN_BYPASS_REPAIR_NAME_PATTERN.test(workflowName);
}

/** Matches workflows filed by `scripts/e2e-regression-watch.mjs`, tagged via their description marker. */
export function isE2eRepairWorkflow(workflowDescription: string | undefined): boolean {
  return typeof workflowDescription === 'string' && workflowDescription.includes(E2E_REPAIR_MARKER);
}

/**
 * Whether a workflow belongs to one of the two automated repair families this
 * cleanup worker is scoped to. Every task in a non-matching workflow is left
 * alone, no matter its status or idle time.
 */
export function isCleanupEligibleWorkflow(workflow: { name?: string; description?: string }): boolean {
  return isAdminBypassRepairTask(workflow.name) || isE2eRepairWorkflow(workflow.description);
}
