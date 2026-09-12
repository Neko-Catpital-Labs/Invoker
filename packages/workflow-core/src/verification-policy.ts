import {
  compileVerificationRequirements,
  type VerificationChangeClass,
  type VerificationReceipt,
  type VerificationRequirementKind,
} from '@invoker/contracts';

export type AutomaticVerificationTarget = 'completion' | 'review_ready';

export type VerificationRefusal =
  | {
    code: 'missing_receipt';
    requirement: VerificationRequirementKind;
  }
  | {
    code: 'failed_receipt' | 'stale_receipt';
    requirement: VerificationRequirementKind;
    receiptId: string;
  }
  | {
    code: 'disagreeing_receipts';
    requirement: VerificationRequirementKind;
    receiptIds: string[];
  }
  | {
    code: 'builder_is_sole_judge';
    requirement: 'independent_judgment';
  };

export interface AutomaticVerificationReadinessInput {
  target: AutomaticVerificationTarget;
  targetCommitSha: string;
  builderActorId: string;
  changeClasses: readonly VerificationChangeClass[];
  receipts: readonly VerificationReceipt[];
}

export interface AutomaticVerificationReadinessDecision {
  ready: boolean;
  target: AutomaticVerificationTarget;
  targetCommitSha: string;
  requirements: VerificationRequirementKind[];
  refusals: VerificationRefusal[];
}

function normalizedSha(value: string): string {
  return value.trim().toLowerCase();
}

function hasText(value: string): boolean {
  return value.trim().length > 0;
}

function receiptPassed(receipt: VerificationReceipt, targetCommitSha: string): boolean {
  if (receipt.status !== 'passed') return false;
  switch (receipt.kind) {
    case 'deterministic_command':
      return receipt.exitCode === 0
        && hasText(receipt.command)
        && hasText(receipt.output);
    case 'bug_repro_fail_pass':
      return receipt.before.exitCode !== 0
        && receipt.after.exitCode === 0
        && hasText(receipt.before.command)
        && receipt.before.command.trim() === receipt.after.command.trim()
        && hasText(receipt.before.output)
        && hasText(receipt.after.output);
    case 'opened_visual_proof':
      return hasText(receipt.mediaPath)
        && hasText(receipt.openedAt)
        && hasText(receipt.observation);
    case 'external_effect_reconciliation':
      return receipt.reconciled
        && hasText(receipt.system)
        && hasText(receipt.expectedState)
        && hasText(receipt.observedState);
    case 'deployed_version':
      return normalizedSha(receipt.deployedCommitSha) === targetCommitSha
        && hasText(receipt.environment)
        && hasText(receipt.version);
    case 'independent_judgment':
      return receipt.verdict === 'approve'
        && receipt.actor.role === 'judge'
        && hasText(receipt.rationale);
  }
}

function receiptOutcome(receipt: VerificationReceipt, targetCommitSha: string): 'passed' | 'failed' {
  return receiptPassed(receipt, targetCommitSha) ? 'passed' : 'failed';
}

function receiptsForRequirement(
  receipts: readonly VerificationReceipt[],
  requirement: VerificationRequirementKind,
): VerificationReceipt[] {
  return receipts.filter((receipt) => receipt.kind === requirement);
}

export function evaluateAutomaticVerificationReadiness(
  input: AutomaticVerificationReadinessInput,
): AutomaticVerificationReadinessDecision {
  const targetCommitSha = normalizedSha(input.targetCommitSha);
  const requirements = compileVerificationRequirements(input.changeClasses);
  const refusals: VerificationRefusal[] = [];

  for (const requirement of requirements) {
    const receipts = receiptsForRequirement(input.receipts, requirement);
    if (receipts.length === 0) {
      refusals.push({ code: 'missing_receipt', requirement });
      continue;
    }

    const currentReceipts = receipts.filter((receipt) => {
      if (normalizedSha(receipt.commitSha) === targetCommitSha) return true;
      refusals.push({
        code: 'stale_receipt',
        requirement,
        receiptId: receipt.id,
      });
      return false;
    });

    const outcomes = new Set<'passed' | 'failed'>();
    for (const receipt of currentReceipts) {
      const outcome = receiptOutcome(receipt, targetCommitSha);
      outcomes.add(outcome);
      if (outcome === 'failed') {
        refusals.push({
          code: 'failed_receipt',
          requirement,
          receiptId: receipt.id,
        });
      }
    }
    if (outcomes.size > 1) {
      refusals.push({
        code: 'disagreeing_receipts',
        requirement,
        receiptIds: currentReceipts.map((receipt) => receipt.id),
      });
    }

    if (requirement === 'independent_judgment') {
      const independentJudge = currentReceipts.some((receipt) =>
        receipt.kind === 'independent_judgment'
          && receipt.actor.role === 'judge'
          && receipt.actor.id !== input.builderActorId,
      );
      if (!independentJudge) {
        refusals.push({
          code: 'builder_is_sole_judge',
          requirement: 'independent_judgment',
        });
      }
    }
  }

  return {
    ready: refusals.length === 0,
    target: input.target,
    targetCommitSha,
    requirements,
    refusals,
  };
}
