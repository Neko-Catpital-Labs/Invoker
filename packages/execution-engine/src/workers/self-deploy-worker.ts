import { spawn } from 'node:child_process';

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import { shellPosixSingleQuote } from '../ssh-git-exec.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import { expandLocalRepoPath } from './catstack-deploy-worker.js';
import { hasExecutingOrUnknownTask } from './idle-task-cleanup-policy.js';

export const SELF_DEPLOY_WORKER_KIND = 'self-deploy';
export const DEFAULT_SELF_DEPLOY_INTERVAL_MINUTES = 30;
export const DEFAULT_SELF_DEPLOY_INTERVAL_MS = DEFAULT_SELF_DEPLOY_INTERVAL_MINUTES * 60 * 1000;
export const DEFAULT_SELF_DEPLOY_REMOTE_NAME = 'upstream';
export const DEFAULT_SELF_DEPLOY_BRANCH_NAME = 'master';
export const DEFAULT_SELF_DEPLOY_REPO_PATH = '~/Invoker';
export const DEFAULT_SELF_DEPLOY_SCRIPT_PATH = 'scripts/deploy-do1.sh';
const SELF_DEPLOY_SUBJECT_ID = 'do1';

export interface SelfDeployWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
}

export interface SelfDeployWorkerConfig {
  intervalMs?: number;
  repoPath?: string;
  remoteName?: string;
  branchName?: string;
  deployScriptPath?: string;
  tickOnStart?: boolean;
  store?: SelfDeployWorkerStore;
  hasRunningTasks?: () => boolean | Promise<boolean>;
  getRemoteHeadSha?: (repoPath: string, remoteName: string, branchName: string) => Promise<string>;
  runDeploy?: (deployScriptPath: string) => Promise<void>;
  onTick?: WorkerTick;
}

export interface SelfDeployWorkerOptions {
  logger: Logger;
  intervalMs?: number;
  repoPath: string;
  remoteName: string;
  branchName: string;
  deployScriptPath: string;
  tickOnStart?: boolean;
  store?: SelfDeployWorkerStore;
  hasRunningTasks?: () => boolean | Promise<boolean>;
  getRemoteHeadSha?: (repoPath: string, remoteName: string, branchName: string) => Promise<string>;
  runDeploy?: (deployScriptPath: string) => Promise<void>;
  onTick?: WorkerTick;
}

function runLocalBashScriptCaptured(script: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('bash', ['-lc', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      rejectPromise(new Error(`command failed (exit=${code ?? 'unknown'}): ${stderr.trim() || 'no stderr'}`));
    });
  });
}

function buildRemoteHeadShaScript(repoPath: string, remoteName: string, branchName: string): string {
  const pathQ = shellPosixSingleQuote(repoPath);
  const remoteQ = shellPosixSingleQuote(remoteName);
  const branchQ = shellPosixSingleQuote(branchName);
  return `set -euo pipefail
cd ${pathQ}
git fetch ${remoteQ} ${branchQ}
git rev-parse ${remoteQ}/${branchQ}
`;
}

async function defaultGetRemoteHeadSha(repoPath: string, remoteName: string, branchName: string): Promise<string> {
  const stdout = await runLocalBashScriptCaptured(buildRemoteHeadShaScript(repoPath, remoteName, branchName));
  return stdout.trim();
}

async function defaultRunDeploy(deployScriptPath: string): Promise<void> {
  await runLocalBashScriptCaptured(`bash ${shellPosixSingleQuote(deployScriptPath)}`);
}

function defaultHasRunningTasks(store: SelfDeployWorkerStore | undefined): boolean {
  if (!store) return false;
  return store.listWorkflows().some((workflow) => hasExecutingOrUnknownTask(store.loadTasks(workflow.id)));
}

function readDeployedSha(store: WorkerDecisionStore | undefined, subjectId: string): string | undefined {
  const action = store?.getWorkerAction?.(SELF_DEPLOY_WORKER_KIND, subjectId);
  const payload = action?.payload;
  if (payload && typeof payload === 'object' && 'deployedSha' in payload) {
    const sha = (payload as Record<string, unknown>).deployedSha;
    if (typeof sha === 'string' && sha.length > 0) return sha;
  }
  return undefined;
}

function recordDecision(
  store: WorkerDecisionStore | undefined,
  subjectId: string,
  status: 'completed' | 'failed' | 'skipped',
  summary: string,
  deployedSha: string | undefined,
): void {
  if (!store) return;
  recordWorkerDecisionRow(store, {
    workerKind: SELF_DEPLOY_WORKER_KIND,
    actionType: 'self-deploy',
    externalKey: subjectId,
    subjectType: 'host',
    subjectId,
    status,
    summary,
    payload: deployedSha ? { deployedSha } : {},
  });
}

export async function runSelfDeployTick(options: SelfDeployWorkerOptions): Promise<void> {
  const getRemoteHeadSha = options.getRemoteHeadSha ?? defaultGetRemoteHeadSha;
  const runDeploy = options.runDeploy ?? defaultRunDeploy;
  const hasRunningTasks = options.hasRunningTasks ?? (() => defaultHasRunningTasks(options.store));
  const repoPath = expandLocalRepoPath(options.repoPath);
  const deployedSha = readDeployedSha(options.store, SELF_DEPLOY_SUBJECT_ID);
  const logFields = { module: SELF_DEPLOY_WORKER_KIND, repoPath };

  let remoteSha: string;
  try {
    remoteSha = await getRemoteHeadSha(repoPath, options.remoteName, options.branchName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.logger.error(
      `[${SELF_DEPLOY_WORKER_KIND}] failed to resolve ${options.remoteName}/${options.branchName}: ${detail}`,
      logFields,
    );
    recordDecision(
      options.store,
      SELF_DEPLOY_SUBJECT_ID,
      'failed',
      `Failed to resolve ${options.remoteName}/${options.branchName}: ${detail}`,
      deployedSha,
    );
    return;
  }

  if (remoteSha === deployedSha) {
    options.logger.info(
      `[${SELF_DEPLOY_WORKER_KIND}] ${options.remoteName}/${options.branchName} unchanged at ${remoteSha}`,
      { ...logFields, sha: remoteSha },
    );
    return;
  }

  let running: boolean;
  try {
    running = await hasRunningTasks();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.logger.error(
      `[${SELF_DEPLOY_WORKER_KIND}] failed to check running tasks; skipping deploy for safety: ${detail}`,
      { ...logFields, sha: remoteSha },
    );
    recordDecision(
      options.store,
      SELF_DEPLOY_SUBJECT_ID,
      'skipped',
      `Skipped deploy to ${remoteSha}: could not check running tasks (${detail})`,
      deployedSha,
    );
    return;
  }

  if (running) {
    options.logger.info(
      `[${SELF_DEPLOY_WORKER_KIND}] skipping deploy to ${remoteSha}: DO1 has active running tasks`,
      { ...logFields, sha: remoteSha },
    );
    recordDecision(
      options.store,
      SELF_DEPLOY_SUBJECT_ID,
      'skipped',
      `Skipped deploy to ${remoteSha}: active running tasks on DO1`,
      deployedSha,
    );
    return;
  }

  try {
    await runDeploy(options.deployScriptPath);
    recordDecision(options.store, SELF_DEPLOY_SUBJECT_ID, 'completed', `Deployed DO1 to ${remoteSha}`, remoteSha);
    options.logger.info(`[${SELF_DEPLOY_WORKER_KIND}] deploy ok`, { ...logFields, sha: remoteSha });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.logger.error(`[${SELF_DEPLOY_WORKER_KIND}] deploy failed: ${detail}`, { ...logFields, sha: remoteSha });
    recordDecision(
      options.store,
      SELF_DEPLOY_SUBJECT_ID,
      'failed',
      `Deploy to ${remoteSha} failed: ${detail}`,
      deployedSha,
    );
  }
}

export function createSelfDeployWorker(config: SelfDeployWorkerConfig & { logger: Logger }): WorkerRuntime {
  const options: SelfDeployWorkerOptions = {
    logger: config.logger,
    intervalMs: config.intervalMs,
    repoPath: config.repoPath ?? DEFAULT_SELF_DEPLOY_REPO_PATH,
    remoteName: config.remoteName ?? DEFAULT_SELF_DEPLOY_REMOTE_NAME,
    branchName: config.branchName ?? DEFAULT_SELF_DEPLOY_BRANCH_NAME,
    deployScriptPath: config.deployScriptPath ?? DEFAULT_SELF_DEPLOY_SCRIPT_PATH,
    tickOnStart: config.tickOnStart,
    store: config.store,
    hasRunningTasks: config.hasRunningTasks,
    getRemoteHeadSha: config.getRemoteHeadSha,
    runDeploy: config.runDeploy,
  };
  const onTick: WorkerTick = config.onTick ?? (async () => {
    await runSelfDeployTick(options);
  });
  return createWorkerRuntime({
    kind: SELF_DEPLOY_WORKER_KIND,
    logger: config.logger,
    onTick,
    intervalMs: config.intervalMs ?? DEFAULT_SELF_DEPLOY_INTERVAL_MS,
    tickOnStart: config.tickOnStart ?? true,
  });
}

export function registerSelfDeployWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: SELF_DEPLOY_WORKER_KIND,
    note: 'Redeploys DO1 from upstream/master on an interval via scripts/deploy-do1.sh, skipping while DO1 has active running tasks. Opt-in; intended for the DO1 owner only.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createSelfDeployWorker({
        logger: deps.logger,
        store: deps.store,
        ...deps.selfDeploy,
      }),
  });
  return registry;
}
