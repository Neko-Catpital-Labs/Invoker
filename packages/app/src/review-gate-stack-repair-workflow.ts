import type { Logger } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type {
  ReviewGateCiRepairWorkflowMutationArgs,
  ReviewGateFailedCheck,
  StackPrRecord,
} from '@invoker/execution-engine';
import type { Orchestrator, PlanDefinition, TaskState } from '@invoker/workflow-core';

import { backupPlan } from './plan-backup.js';
import {
  assertSourceReviewGateLineage,
  buildFailedCheckBullet,
  loadSourceTask,
  resolveBaseBranch,
  type SpawnReviewGateCiRepairWorkflowDeps,
} from './review-gate-ci-repair-workflow.js';

export interface SpawnReviewGateStackCiRepairWorkflowArgs {
  /** Deterministic id from pr-stack-detection's detectStack(), used as the
   *  dedup key for in-flight stack repairs. */
  readonly stackId: string;
  /** Bottom-to-top stack membership at detection time — re-verified live
   *  (see assertMembersNotStale) before any plan is built. */
  readonly members: readonly StackPrRecord[];
  /** The single PR whose review_gate.ci_failed event actually triggered this
   *  batch. Only this member gets check-fix tasks in v1 — every other member
   *  gets a pass-through recheck task that gates the PR above it. A sibling's
   *  own failing checks get added the next time ITS OWN event fires and finds
   *  this same stack (at which point it becomes the triggering member). */
  readonly triggering: ReviewGateCiRepairWorkflowMutationArgs;
}

export interface SpawnReviewGateStackCiRepairWorkflowDeps {
  orchestrator: Pick<Orchestrator, 'getWorkflowIds' | 'loadPlan' | 'startExecution'>;
  persistence: SpawnReviewGateCiRepairWorkflowDeps['persistence'];
  /** Re-fetches live PR state for every member so a stack that changed shape
   *  (a push, a merge, a close) between detection and spawn never proceeds. */
  fetchOpenStackPrs: () => Promise<readonly StackPrRecord[]>;
  logger?: Logger;
  allowGraphMutation?: boolean;
}

export interface SpawnReviewGateStackCiRepairWorkflowResult {
  workflowId: string;
  stackId: string;
  /** PR number -> that member's recheck task id, so callers (and the
   *  in-flight ledger) can watch each member's terminal state. */
  memberTaskIds: Readonly<Record<number, string>>;
  started: TaskState[];
}

function slugifyCheckName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'check';
}

function checkTaskId(prNumber: number, index: number, checkName: string): string {
  return `pr-${prNumber}-check-${index}-${slugifyCheckName(checkName)}`;
}

function recheckTaskId(prNumber: number): string {
  return `pr-${prNumber}-recheck`;
}

function buildCheckFixPrompt(
  member: StackPrRecord,
  check: ReviewGateFailedCheck,
  baseBranch: string,
  triggering: ReviewGateCiRepairWorkflowMutationArgs,
): string {
  return [
    `Repair one failing check on pull request #${member.number} (part of a Mergify stack).`,
    `PR URL: ${triggering.reviewUrl}`,
    `Head branch: ${member.headRefName}`,
    `Head SHA: ${member.headRefOid}`,
    `Base branch: ${baseBranch}`,
    '',
    'Work directly on the review branch:',
    `  git fetch origin ${member.headRefName} && git checkout ${member.headRefName}`,
    '',
    'Failed check to clear:',
    buildFailedCheckBullet(check),
    '',
    'Rules:',
    '- Fix only this failing check on the same branch.',
    `- Push your changes to the same branch (${member.headRefName}).`,
    '- Never open a new PR.',
    '- Do not touch any other PR in the stack.',
  ].join('\n');
}

function buildRecheckPrompt(member: StackPrRecord, baseBranch: string): string {
  return [
    `Confirm pull request #${member.number} is green after its stack-mates' repairs.`,
    `Head branch: ${member.headRefName}`,
    `Base branch: ${baseBranch}`,
    '',
    'This PR had no failing checks assigned to this batch, or its check-fix',
    'tasks above have already completed. Re-fetch its current required checks',
    '(`gh pr checks` or the review-gate poll) and confirm they are green before',
    'reporting done. If a required check is still failing, say so plainly —',
    'do not silently retry a fix here; a fresh CI-failure event on this PR is',
    'what should trigger new check-fix tasks.',
  ].join('\n');
}

/**
 * One task per failing required check on the TRIGGERING member (Q, R, S),
 * plus one pass-through "recheck" task per member gated on that member's own
 * check tasks. Cross-PR ordering: member N's tasks additionally depend on
 * member N-1's recheck task, so nothing above a broken PR ever starts before
 * that PR is confirmed green. See pr-stack-detection.ts for how `members` is
 * derived and review-gate-stack-repair-workflow.ts's module doc for why only
 * the triggering member gets check-fix tasks in v1.
 */
export function buildStackRepairPlanTasks(
  members: readonly StackPrRecord[],
  triggering: ReviewGateCiRepairWorkflowMutationArgs,
  baseBranch: string,
): PlanDefinition['tasks'] {
  const tasks: PlanDefinition['tasks'] = [];
  let previousRecheckId: string | undefined;

  for (const member of members) {
    const isTriggering = String(member.number) === triggering.reviewId;
    const ownCheckIds: string[] = [];

    if (isTriggering) {
      triggering.failedChecks.forEach((check, index) => {
        const id = checkTaskId(member.number, index, check.name);
        ownCheckIds.push(id);
        tasks.push({
          id,
          description: `PR #${member.number}: fix failing check ${check.name}`,
          prompt: buildCheckFixPrompt(member, check, baseBranch, triggering),
          featureBranch: member.headRefName,
          ...(previousRecheckId ? { dependencies: [previousRecheckId] } : {}),
        });
      });
    }

    tasks.push({
      id: recheckTaskId(member.number),
      description: `PR #${member.number}: recheck after repairs`,
      prompt: buildRecheckPrompt(member, baseBranch),
      featureBranch: member.headRefName,
      dependencies: previousRecheckId ? [...ownCheckIds, previousRecheckId] : ownCheckIds,
    });

    previousRecheckId = recheckTaskId(member.number);
  }

  return tasks;
}

/**
 * Fail-closed guard for the whole batch (plan §4/§1): re-fetches live PR
 * state and aborts before anything is built if ANY member has moved (closed,
 * merged out from under us, or a new head SHA landed) since detectStack()
 * ran. A stale member could silently break the dependency chain other
 * members' tasks rely on, so one bad member blocks the whole spawn rather
 * than being dropped.
 */
export async function assertMembersNotStale(
  members: readonly StackPrRecord[],
  fetchOpenStackPrs: () => Promise<readonly StackPrRecord[]>,
): Promise<void> {
  const latest = await fetchOpenStackPrs();
  const byNumber = new Map(latest.map((pr) => [pr.number, pr] as const));
  for (const member of members) {
    const current = byNumber.get(member.number);
    if (!current || current.state !== 'OPEN') {
      throw new Error(
        `Review-gate stack CI repair is stale: PR #${member.number} is no longer open.`,
      );
    }
    if (current.headRefOid !== member.headRefOid) {
      throw new Error(
        `Review-gate stack CI repair is stale: PR #${member.number} head changed `
        + `(${member.headRefOid} → ${current.headRefOid}).`,
      );
    }
  }
}

export async function spawnReviewGateStackCiRepairWorkflow(
  args: SpawnReviewGateStackCiRepairWorkflowArgs,
  deps: SpawnReviewGateStackCiRepairWorkflowDeps,
): Promise<SpawnReviewGateStackCiRepairWorkflowResult> {
  const sourceTask = loadSourceTask(args.triggering.sourceWorkflowId, args.triggering.sourceTaskId, deps);
  if (!sourceTask) {
    throw new Error(`Review-gate stack CI repair source task ${args.triggering.sourceTaskId} not found.`);
  }
  const sourceWorkflow = deps.persistence.loadWorkflow(args.triggering.sourceWorkflowId);
  if (!sourceWorkflow) {
    throw new Error(`Review-gate stack CI repair source workflow ${args.triggering.sourceWorkflowId} not found.`);
  }
  assertSourceReviewGateLineage(sourceTask, args.triggering);
  await assertMembersNotStale(args.members, deps.fetchOpenStackPrs);

  const baseBranch = resolveBaseBranch(sourceWorkflow.baseBranch);
  const headShaOrNoHead = args.triggering.headSha ?? 'no-head';
  const planNameSafeStackId = args.stackId.replace(/[^a-zA-Z0-9]+/g, '-');
  const plan: PlanDefinition = {
    name: `repair-review-gate-ci-stack-${planNameSafeStackId}-${headShaOrNoHead}`,
    onFinish: 'none',
    baseBranch,
    ...(sourceWorkflow.repoUrl ? { repoUrl: sourceWorkflow.repoUrl } : {}),
    ...(sourceWorkflow.intermediateRepoUrl ? { intermediateRepoUrl: sourceWorkflow.intermediateRepoUrl } : {}),
    tasks: buildStackRepairPlanTasks(args.members, args.triggering, baseBranch),
  };

  const existingWorkflowIds = new Set(deps.persistence.listWorkflows().map((workflow) => workflow.id));
  backupPlan(plan, undefined, deps.logger);
  deps.orchestrator.loadPlan(plan, { allowGraphMutation: deps.allowGraphMutation });
  const workflowId = deps.orchestrator.getWorkflowIds().find((id) => !existingWorkflowIds.has(id));
  if (!workflowId) {
    throw new Error('Loaded review-gate stack CI repair plan did not create a workflow.');
  }
  const started = deps.orchestrator
    .startExecution()
    .filter((task) => task.config.workflowId === workflowId);
  const memberTaskIds = Object.fromEntries(
    args.members.map((member) => [member.number, `${workflowId}/${recheckTaskId(member.number)}`]),
  );
  return { workflowId, stackId: args.stackId, memberTaskIds, started };
}
