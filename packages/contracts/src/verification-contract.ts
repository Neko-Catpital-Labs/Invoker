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

export type VerificationAttestationProviderKind = 'executor' | 'judge';

export interface VerificationAttestationProvider {
  kind: VerificationAttestationProviderKind;
  providerId: string;
}

export type VerificationSignatureAlgorithm = 'Ed25519';

export interface VerificationAttestationV2 {
  repository: string;
  workflowId: string;
  taskId: string;
  generation: number;
  attemptId?: string;
  commitSha: string;
  canonicalPayloadDigest: string;
  signatureAlgorithm: VerificationSignatureAlgorithm;
  signature: string;
  trustedKeyId: string;
  provider: VerificationAttestationProvider;
  actorId: string;
  issuedAt: string;
  recordedAt: string;
}

export interface LegacyUntrustedVerificationEvidenceRecord {
  version: 1;
  trust: 'untrusted';
  receipt: VerificationReceipt;
}

export interface TrustedVerificationEvidenceRecord {
  version: 2;
  trust: 'trusted';
  receipt: VerificationReceipt;
  attestation: VerificationAttestationV2;
}

export type VerificationEvidenceRecord =
  | LegacyUntrustedVerificationEvidenceRecord
  | TrustedVerificationEvidenceRecord;

type UnknownRecord = Record<string, unknown>;

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function evidenceObject(value: unknown, field: string): UnknownRecord {
  if (!isUnknownRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function evidenceText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function evidenceTimestamp(value: unknown, field: string): string {
  const timestamp = evidenceText(value, field);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${field} must be a valid timestamp`);
  }
  return timestamp;
}

function evidenceInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return value;
}

function evidenceNonNegativeInteger(value: unknown, field: string): number {
  const integer = evidenceInteger(value, field);
  if (integer < 0) throw new Error(`${field} must be non-negative`);
  return integer;
}

function evidenceBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function parseVerificationActor(value: unknown, field: string): VerificationActor {
  const actor = evidenceObject(value, field);
  const role = actor.role;
  if (role !== 'builder' && role !== 'verifier' && role !== 'judge') {
    throw new Error(`${field}.role must be builder, verifier, or judge`);
  }
  return {
    id: evidenceText(actor.id, `${field}.id`),
    role,
  };
}

interface ParsedReceiptBase {
  id: string;
  commitSha: string;
  recordedAt: string;
  actor: VerificationActor;
  status: 'passed' | 'failed';
}

function parseReceiptBase(receipt: UnknownRecord): ParsedReceiptBase {
  const status = receipt.status;
  if (status !== 'passed' && status !== 'failed') {
    throw new Error('receipt.status must be passed or failed');
  }
  return {
    id: evidenceText(receipt.id, 'receipt.id'),
    commitSha: evidenceText(receipt.commitSha, 'receipt.commitSha'),
    recordedAt: evidenceTimestamp(receipt.recordedAt, 'receipt.recordedAt'),
    actor: parseVerificationActor(receipt.actor, 'receipt.actor'),
    status,
  };
}

interface ParsedCommandResult {
  command: string;
  exitCode: number;
  output: string;
}

function parseCommandResult(value: unknown, field: string): ParsedCommandResult {
  const result = evidenceObject(value, field);
  return {
    command: evidenceText(result.command, `${field}.command`),
    exitCode: evidenceInteger(result.exitCode, `${field}.exitCode`),
    output: evidenceText(result.output, `${field}.output`),
  };
}

export function parseVerificationReceipt(value: unknown): VerificationReceipt {
  const receipt = evidenceObject(value, 'receipt');
  const base = parseReceiptBase(receipt);

  switch (receipt.kind) {
    case 'deterministic_command':
      return {
        ...base,
        kind: 'deterministic_command',
        command: evidenceText(receipt.command, 'receipt.command'),
        exitCode: evidenceInteger(receipt.exitCode, 'receipt.exitCode'),
        output: evidenceText(receipt.output, 'receipt.output'),
      };
    case 'bug_repro_fail_pass':
      return {
        ...base,
        kind: 'bug_repro_fail_pass',
        before: parseCommandResult(receipt.before, 'receipt.before'),
        after: parseCommandResult(receipt.after, 'receipt.after'),
      };
    case 'opened_visual_proof':
      return {
        ...base,
        kind: 'opened_visual_proof',
        mediaPath: evidenceText(receipt.mediaPath, 'receipt.mediaPath'),
        openedAt: evidenceTimestamp(receipt.openedAt, 'receipt.openedAt'),
        observation: evidenceText(receipt.observation, 'receipt.observation'),
      };
    case 'external_effect_reconciliation':
      return {
        ...base,
        kind: 'external_effect_reconciliation',
        system: evidenceText(receipt.system, 'receipt.system'),
        expectedState: evidenceText(receipt.expectedState, 'receipt.expectedState'),
        observedState: evidenceText(receipt.observedState, 'receipt.observedState'),
        reconciled: evidenceBoolean(receipt.reconciled, 'receipt.reconciled'),
      };
    case 'deployed_version':
      return {
        ...base,
        kind: 'deployed_version',
        environment: evidenceText(receipt.environment, 'receipt.environment'),
        deployedCommitSha: evidenceText(receipt.deployedCommitSha, 'receipt.deployedCommitSha'),
        version: evidenceText(receipt.version, 'receipt.version'),
      };
    case 'independent_judgment': {
      const verdict = receipt.verdict;
      if (verdict !== 'approve' && verdict !== 'reject') {
        throw new Error('receipt.verdict must be approve or reject');
      }
      return {
        ...base,
        kind: 'independent_judgment',
        verdict,
        rationale: evidenceText(receipt.rationale, 'receipt.rationale'),
      };
    }
    default:
      throw new Error('receipt.kind is not a supported verification receipt kind');
  }
}

function parseVerificationAttestationV2(value: unknown): VerificationAttestationV2 {
  const attestation = evidenceObject(value, 'attestation');
  const provider = evidenceObject(attestation.provider, 'attestation.provider');
  const providerKind = provider.kind;
  if (providerKind !== 'executor' && providerKind !== 'judge') {
    throw new Error('attestation.provider.kind must be executor or judge');
  }
  if (attestation.signatureAlgorithm !== 'Ed25519') {
    throw new Error('attestation.signatureAlgorithm must be Ed25519');
  }

  const attemptId = attestation.attemptId === undefined
    ? undefined
    : evidenceText(attestation.attemptId, 'attestation.attemptId');

  return {
    repository: evidenceText(attestation.repository, 'attestation.repository'),
    workflowId: evidenceText(attestation.workflowId, 'attestation.workflowId'),
    taskId: evidenceText(attestation.taskId, 'attestation.taskId'),
    generation: evidenceNonNegativeInteger(attestation.generation, 'attestation.generation'),
    ...(attemptId === undefined ? {} : { attemptId }),
    commitSha: evidenceText(attestation.commitSha, 'attestation.commitSha'),
    canonicalPayloadDigest: evidenceText(
      attestation.canonicalPayloadDigest,
      'attestation.canonicalPayloadDigest',
    ),
    signatureAlgorithm: 'Ed25519',
    signature: evidenceText(attestation.signature, 'attestation.signature'),
    trustedKeyId: evidenceText(attestation.trustedKeyId, 'attestation.trustedKeyId'),
    provider: {
      kind: providerKind,
      providerId: evidenceText(provider.providerId, 'attestation.provider.providerId'),
    },
    actorId: evidenceText(attestation.actorId, 'attestation.actorId'),
    issuedAt: evidenceTimestamp(attestation.issuedAt, 'attestation.issuedAt'),
    recordedAt: evidenceTimestamp(attestation.recordedAt, 'attestation.recordedAt'),
  };
}

function assertAttestationMatchesReceipt(
  receipt: VerificationReceipt,
  attestation: VerificationAttestationV2,
): void {
  if (attestation.commitSha.trim().toLowerCase() !== receipt.commitSha.trim().toLowerCase()) {
    throw new Error('attestation.commitSha must match receipt.commitSha');
  }
  if (attestation.actorId !== receipt.actor.id) {
    throw new Error('attestation.actorId must match receipt.actor.id');
  }
  const isJudgment = receipt.kind === 'independent_judgment';
  if (isJudgment && receipt.actor.role !== 'judge') {
    throw new Error('trusted independent judgments require receipt.actor.role judge');
  }
  if (isJudgment && attestation.provider.kind !== 'judge') {
    throw new Error('trusted independent judgments require a judge provider');
  }
  if (!isJudgment && attestation.provider.kind !== 'executor') {
    throw new Error('trusted non-judgment receipts require an executor provider');
  }
}

export function parseVerificationEvidenceRecord(value: unknown): VerificationEvidenceRecord {
  const record = evidenceObject(value, 'verification evidence record');
  const receipt = parseVerificationReceipt(record.receipt);

  if (record.version === 1) {
    if (record.trust !== 'untrusted') {
      throw new Error('version-1 verification evidence must be untrusted');
    }
    return { version: 1, trust: 'untrusted', receipt };
  }

  if (record.version === 2) {
    if (record.trust !== 'trusted') {
      throw new Error('version-2 verification evidence must be trusted');
    }
    const attestation = parseVerificationAttestationV2(record.attestation);
    assertAttestationMatchesReceipt(receipt, attestation);
    return { version: 2, trust: 'trusted', receipt, attestation };
  }

  throw new Error('verification evidence record.version must be 1 or 2');
}

export function isVerificationEvidenceRecord(value: unknown): value is VerificationEvidenceRecord {
  try {
    parseVerificationEvidenceRecord(value);
    return true;
  } catch {
    return false;
  }
}

export function isTrustedVerificationEvidenceRecord(
  value: unknown,
): value is TrustedVerificationEvidenceRecord {
  try {
    return parseVerificationEvidenceRecord(value).version === 2;
  } catch {
    return false;
  }
}

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
