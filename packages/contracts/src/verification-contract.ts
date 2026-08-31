export type VerificationChangeClass =
  | 'code'
  | 'bug_fix'
  | 'visual_ui'
  | 'external_effect'
  | 'deployment'
  | 'documentation';

export type VerificationRequirementKind =
  | 'deterministic_command'
  | 'bug_repro_fail_pass'
  | 'opened_visual_proof'
  | 'external_effect_reconciliation'
  | 'deployed_version'
  | 'independent_judgment';

export type VerifierWorkflowPhase =
  | 'discovered'
  | 'validated'
  | 'dispatched'
  | 'pr_opened'
  | 'no_finding'
  | 'independently_graded'
  | 'terminal';

export interface VerifierFindingIdentity {
  repository: string;
  baseCommitSha: string;
  sourceSessionId: string;
  findingHash: string;
}

export interface CanonicalVerifierFindingIdentity extends VerifierFindingIdentity {
  key: string;
}

export type VerifierWorkflowEvent =
  | { phase: 'discovered'; at: string }
  | { phase: 'validated'; at: string }
  | { phase: 'dispatched'; workflowId: string; at: string }
  | { phase: 'pr_opened'; pullRequestUrl: string; at: string }
  | { phase: 'no_finding'; reason: string; at: string }
  | {
    phase: 'independently_graded';
    grade: 'accepted' | 'rejected';
    graderId: string;
    at: string;
  }
  | {
    phase: 'terminal';
    outcome: 'pr_opened' | 'no_finding' | 'rejected';
    at: string;
  };

export interface VerifierWorkflowRecord {
  version: 1;
  identity: CanonicalVerifierFindingIdentity;
  phase: VerifierWorkflowPhase;
  history: VerifierWorkflowEvent[];
}

export interface CreateVerifierWorkflowInput extends VerifierFindingIdentity {
  discoveredAt: string;
}

export type AdvanceVerifierWorkflowEvent = Exclude<VerifierWorkflowEvent, { phase: 'discovered' }>;

export type VerificationActorRole = 'builder' | 'verifier' | 'judge';

export interface VerificationActor {
  id: string;
  role: VerificationActorRole;
}

interface VerificationReceiptBase {
  id: string;
  commitSha: string;
  recordedAt: string;
  actor: VerificationActor;
  status: 'passed' | 'failed';
}

export interface DeterministicCommandReceipt extends VerificationReceiptBase {
  kind: 'deterministic_command';
  command: string;
  exitCode: number;
  output: string;
}

export interface BugReproFailPassReceipt extends VerificationReceiptBase {
  kind: 'bug_repro_fail_pass';
  before: {
    command: string;
    exitCode: number;
    output: string;
  };
  after: {
    command: string;
    exitCode: number;
    output: string;
  };
}

export interface OpenedVisualProofReceipt extends VerificationReceiptBase {
  kind: 'opened_visual_proof';
  mediaPath: string;
  openedAt: string;
  observation: string;
}

export interface ExternalEffectReconciliationReceipt extends VerificationReceiptBase {
  kind: 'external_effect_reconciliation';
  system: string;
  expectedState: string;
  observedState: string;
  reconciled: boolean;
}

export interface DeployedVersionReceipt extends VerificationReceiptBase {
  kind: 'deployed_version';
  environment: string;
  deployedCommitSha: string;
  version: string;
}

export interface IndependentJudgmentReceipt extends VerificationReceiptBase {
  kind: 'independent_judgment';
  verdict: 'approve' | 'reject';
  rationale: string;
}

export type VerificationReceipt =
  | DeterministicCommandReceipt
  | BugReproFailPassReceipt
  | OpenedVisualProofReceipt
  | ExternalEffectReconciliationReceipt
  | DeployedVersionReceipt
  | IndependentJudgmentReceipt;

const requirementOrder: VerificationRequirementKind[] = [
  'deterministic_command',
  'bug_repro_fail_pass',
  'opened_visual_proof',
  'external_effect_reconciliation',
  'deployed_version',
  'independent_judgment',
];

const requirementsByChangeClass: Record<VerificationChangeClass, VerificationRequirementKind[]> = {
  code: [],
  bug_fix: ['bug_repro_fail_pass'],
  visual_ui: ['opened_visual_proof'],
  external_effect: ['external_effect_reconciliation'],
  deployment: ['deployed_version'],
  documentation: [],
};

const nextPhases: Record<VerifierWorkflowPhase, VerifierWorkflowPhase[]> = {
  discovered: ['validated'],
  validated: ['dispatched'],
  dispatched: ['pr_opened', 'no_finding'],
  pr_opened: ['independently_graded'],
  no_finding: ['independently_graded'],
  independently_graded: ['terminal'],
  terminal: [],
};

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  return normalized;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export function canonicalVerifierFindingIdentity(
  input: VerifierFindingIdentity,
): CanonicalVerifierFindingIdentity {
  const repository = requiredText(input.repository, 'repository').toLowerCase();
  const baseCommitSha = requiredText(input.baseCommitSha, 'baseCommitSha').toLowerCase();
  const sourceSessionId = requiredText(input.sourceSessionId, 'sourceSessionId');
  const findingHash = requiredText(input.findingHash, 'findingHash').toLowerCase();
  return {
    repository,
    baseCommitSha,
    sourceSessionId,
    findingHash,
    key: `v1:${encoded(repository)}:${encoded(baseCommitSha)}:${encoded(sourceSessionId)}:${encoded(findingHash)}`,
  };
}

export function canonicalVerifierFindingKey(input: VerifierFindingIdentity): string {
  return canonicalVerifierFindingIdentity(input).key;
}

export function createVerifierWorkflow(input: CreateVerifierWorkflowInput): VerifierWorkflowRecord {
  const discoveredAt = requiredText(input.discoveredAt, 'discoveredAt');
  return {
    version: 1,
    identity: canonicalVerifierFindingIdentity(input),
    phase: 'discovered',
    history: [{ phase: 'discovered', at: discoveredAt }],
  };
}

function sameEvent(left: VerifierWorkflowEvent, right: VerifierWorkflowEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertTerminalOutcome(record: VerifierWorkflowRecord, event: AdvanceVerifierWorkflowEvent): void {
  if (event.phase !== 'terminal') return;
  const grade = record.history.findLast((entry) => entry.phase === 'independently_graded');
  const result = record.history.findLast((entry) => entry.phase === 'pr_opened' || entry.phase === 'no_finding');
  const expectedOutcome = grade?.phase === 'independently_graded' && grade.grade === 'rejected'
    ? 'rejected'
    : result?.phase;
  if (event.outcome !== expectedOutcome) {
    throw new Error(`terminal outcome ${event.outcome} does not match independently graded result ${expectedOutcome ?? 'missing'}`);
  }
}

export function advanceVerifierWorkflow(
  record: VerifierWorkflowRecord,
  event: AdvanceVerifierWorkflowEvent,
): VerifierWorkflowRecord {
  const last = record.history.at(-1);
  if (last && last.phase === event.phase) {
    if (sameEvent(last, event)) return record;
    throw new Error(`phase ${event.phase} was already persisted for ${record.identity.key}`);
  }
  if (record.history.some((entry) => entry.phase === event.phase)) {
    throw new Error(`phase ${event.phase} was already persisted for ${record.identity.key}`);
  }
  if (!nextPhases[record.phase].includes(event.phase)) {
    throw new Error(`cannot transition from ${record.phase} to ${event.phase}`);
  }
  assertTerminalOutcome(record, event);
  return {
    ...record,
    phase: event.phase,
    history: [...record.history, event],
  };
}

export function compileVerificationRequirements(
  changeClasses: readonly VerificationChangeClass[],
): VerificationRequirementKind[] {
  const required = new Set<VerificationRequirementKind>([
    'deterministic_command',
    'independent_judgment',
  ]);
  for (const changeClass of changeClasses) {
    for (const requirement of requirementsByChangeClass[changeClass]) required.add(requirement);
  }
  return requirementOrder.filter((requirement) => required.has(requirement));
}
