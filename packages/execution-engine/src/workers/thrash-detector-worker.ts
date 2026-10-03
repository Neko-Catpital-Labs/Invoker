import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { resolveRepoRoot, type Logger } from '@invoker/contracts';

import { spawnPrMaintenanceCommand, type PrMaintenanceCommandRunner, type PrMaintenanceCommandSpec } from './pr-maintenance-command.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_THRASH_SIGNATURE_ATTEMPT_CAP = 3;

const ATTEMPT_LEDGER_KIND = 'thrash-signature-submit-attempt';
const SUBMITTED_LEDGER_KIND = 'thrash-signature-submitted';

export interface ThrashDetectedSignature {
  readonly signatureId: string;
  readonly windowId: string;
  readonly taskIds: readonly string[];
  readonly prIds?: readonly string[];
  readonly evidence?: readonly string[];
  readonly repoUrl?: string;
  readonly baseBranch?: string;
}

export interface ThrashDetectorWorkerConfig {
  readonly repoRoot?: string;
  readonly ledgerPath?: string;
  readonly intervalMs?: number;
  readonly attemptCap?: number;
  readonly env?: Record<string, string | undefined>;
}

export interface ThrashDetectorTickOptions extends ThrashDetectorWorkerConfig {
  readonly logger: Logger;
  readonly detectSignatures: () => Promise<readonly ThrashDetectedSignature[]> | readonly ThrashDetectedSignature[];
  readonly auditEventLogger?: (eventType: 'thrash.detected', payload: ThrashDetectedSignature) => Promise<void> | void;
  readonly commandRunner?: PrMaintenanceCommandRunner;
  readonly makeTempDir?: (prefix: string) => Promise<string>;
}

export interface ThrashDetectorWorkerOptions extends ThrashDetectorTickOptions {
  readonly instanceId?: string;
  readonly installSignalHandlers?: boolean;
  readonly tickOnStart?: boolean;
  readonly onTick?: WorkerTick;
}

export interface ThrashSignatureSubmissionResult {
  readonly status: 'submitted' | 'skipped' | 'failed';
  readonly reason?: 'already-submitted' | 'attempt-cap' | 'submit-failed';
  readonly attemptsUsed: number;
  readonly planFile?: string;
}

export function createThrashDetectorWorker(options: ThrashDetectorWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: THRASH_DETECTOR_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_THRASH_DETECTOR_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createThrashDetectorTick(options),
    listWorkKeys: () => [THRASH_DETECTOR_WORKER_KIND],
  });
}

export function createThrashDetectorTick(options: ThrashDetectorTickOptions): WorkerTick {
  return async () => {
    const signatures = await options.detectSignatures();
    for (const signature of signatures) {
      await options.auditEventLogger?.('thrash.detected', signature);
      await submitDetectedThrashSignature(signature, options);
    }
  };
}

export async function submitDetectedThrashSignature(
  signature: ThrashDetectedSignature,
  options: Omit<ThrashDetectorTickOptions, 'detectSignatures' | 'auditEventLogger'>,
): Promise<ThrashSignatureSubmissionResult> {
  const ledgerPath = options.ledgerPath ?? defaultThrashSignatureLedgerPath();
  const ledger = new ThrashSignatureLedger(ledgerPath);
  await ledger.init();

  const key = ledgerKeyForSignature(signature);
  const marker = signature.windowId;
  const attemptsUsed = await ledger.count(ATTEMPT_LEDGER_KIND, key, marker);
  if (await ledger.markerSeen(SUBMITTED_LEDGER_KIND, key, marker)) {
    return { status: 'skipped', reason: 'already-submitted', attemptsUsed };
  }

  const attemptCap = options.attemptCap ?? DEFAULT_THRASH_SIGNATURE_ATTEMPT_CAP;
  if (attemptsUsed >= attemptCap) {
    options.logger.warn('[worker:thrash-detector] signature submission attempt cap reached', {
      module: 'thrash-detector-worker',
      worker: THRASH_DETECTOR_WORKER_KIND,
      signatureId: signature.signatureId,
      windowId: signature.windowId,
      attemptCap,
    });
    return { status: 'skipped', reason: 'attempt-cap', attemptsUsed };
  }

  await ledger.record(ATTEMPT_LEDGER_KIND, key, marker);
  const attemptsAfterRecord = attemptsUsed + 1;

  try {
    const submission = await submitThrashSignatureFixPlan(signature, options);
    await ledger.record(SUBMITTED_LEDGER_KIND, key, marker);
    return { status: 'submitted', attemptsUsed: attemptsAfterRecord, planFile: submission.planFile };
  } catch (err) {
    options.logger.error('[worker:thrash-detector] signature submission failed', {
      module: 'thrash-detector-worker',
      worker: THRASH_DETECTOR_WORKER_KIND,
      signatureId: signature.signatureId,
      windowId: signature.windowId,
      err,
    });
    return { status: 'failed', reason: 'submit-failed', attemptsUsed: attemptsAfterRecord };
  }
}

export async function submitThrashSignatureFixPlan(
  signature: ThrashDetectedSignature,
  options: Omit<ThrashDetectorTickOptions, 'detectSignatures' | 'auditEventLogger'>,
): Promise<{ planFile: string; planYaml: string }> {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : resolveRepoRoot(process.cwd());
  const planYaml = buildThrashSignatureFixPlanYaml(signature);
  const tempDir = await (options.makeTempDir ?? mkdtemp)(join(tmpdir(), 'invoker-thrash-signature-'));
  const planFile = join(tempDir, `${sanitizePlanToken(signature.signatureId)}-${sanitizePlanToken(signature.windowId)}.yaml`);
  await writeFile(planFile, planYaml, 'utf8');

  const commandRunner = options.commandRunner ?? spawnPrMaintenanceCommand;
  const result = await commandRunner(createThrashSignatureHeadlessRunCommand({
    repoRoot,
    planFile,
    env: options.env,
  }));

  if (result.spawnError || result.code !== 0) {
    const failure = result.spawnError?.message ?? (result.stderr || `exit ${result.code}`);
    throw new Error(`headless run failed for thrash signature ${signature.signatureId}: ${failure}`);
  }

  return { planFile, planYaml };
}

export function buildThrashSignatureFixPlanYaml(signature: ThrashDetectedSignature): string {
  const prompt = buildThrashSignatureFixPrompt(signature);
  return [
    `name: thrash-signature-${sanitizePlanToken(signature.signatureId)}-${sanitizePlanToken(signature.windowId)}`,
    'onFinish: pull_request',
    'mergeMode: external_review',
    `repoUrl: ${yamlInline(signature.repoUrl ?? 'https://github.com/Neko-Catpital-Labs/Invoker.git')}`,
    `baseBranch: ${yamlInline(signature.baseBranch ?? 'master')}`,
    'tasks:',
    '  - id: fix-thrash-signature',
    `    description: ${yamlInline(`Fix recurring thrash signature ${signature.signatureId}`)}`,
    '    prompt: |',
    indentYamlBlock(prompt, 6),
  ].join('\n');
}

export function createThrashSignatureHeadlessRunCommand(options: {
  readonly repoRoot: string;
  readonly planFile: string;
  readonly env?: Record<string, string | undefined>;
}): PrMaintenanceCommandSpec {
  const childEnv = { ...process.env, ...options.env };
  delete childEnv.INVOKER_HEADLESS_STANDALONE;
  return {
    command: resolve(options.repoRoot, 'run.sh'),
    args: ['--headless', 'run', options.planFile],
    cwd: options.repoRoot,
    env: childEnv,
  };
}

function buildThrashSignatureFixPrompt(signature: ThrashDetectedSignature): string {
  const taskIds = signature.taskIds.length > 0 ? signature.taskIds.join(', ') : '(none recorded)';
  const prIds = signature.prIds && signature.prIds.length > 0 ? signature.prIds.join(', ') : '(none recorded)';
  const evidence = signature.evidence && signature.evidence.length > 0
    ? signature.evidence.map((line) => `- ${line}`).join('\n')
    : '- thrash.detected crossed the configured threshold for this signature/window.';

  return `Goal: fix the recurring root cause behind thrash signature ${signature.signatureId}.

Window: ${signature.windowId}
Recurring task ids: ${taskIds}
Recurring PR ids: ${prIds}

Evidence:
${evidence}

Follow this repository's bug-fix three-phase process from CLAUDE.md before opening a PR:
1. Reproduce the failure with the smallest targeted repro or failing test you can make.
2. Debug and report the observed root cause and the test gap that let it escape.
3. Plan and implement the fix, then rerun the reproduction to prove it now passes.

Do not merge, land, approve, or bypass review. Open the resulting change as a pull request for normal review.`;
}

function defaultThrashSignatureLedgerPath(): string {
  return join(process.env.INVOKER_HOME ?? join(homedir(), '.invoker'), 'thrash-signature-submissions.tsv');
}

function ledgerKeyForSignature(signature: ThrashDetectedSignature): string {
  return signature.signatureId;
}

function sanitizePlanToken(value: string): string {
  const token = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return token || 'signature';
}

function yamlInline(value: string): string {
  return JSON.stringify(value);
}

function indentYamlBlock(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

class ThrashSignatureLedger {
  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, '', 'utf8');
  }

  async record(kind: string, key: string, marker: string): Promise<void> {
    await appendFile(this.path, `${kind}\t${key}\t${marker}\t${Math.floor(Date.now() / 1000)}\n`, 'utf8');
  }

  async count(kind: string, key: string, marker: string): Promise<number> {
    const rows = await this.readRows();
    return rows.filter((row) => row.kind === kind && row.key === key && row.marker === marker).length;
  }

  async markerSeen(kind: string, key: string, marker: string): Promise<boolean> {
    const rows = await this.readRows();
    return rows.some((row) => row.kind === kind && row.key === key && row.marker === marker);
  }

  private async readRows(): Promise<Array<{ kind: string; key: string; marker: string }>> {
    const raw = await readFile(this.path, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });
    return raw.split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [kind = '', key = '', marker = ''] = line.split('\t');
        return { kind, key, marker };
      });
  }
}
