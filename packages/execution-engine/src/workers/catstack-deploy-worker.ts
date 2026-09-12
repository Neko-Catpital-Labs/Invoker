import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { Logger } from '@invoker/contracts';

import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';
import { buildSshConnectionArgs, type SshTargetConnection } from '../ssh-transport-options.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const CATSTACK_DEPLOY_WORKER_KIND = 'catstack-deploy';
export const DEFAULT_CATSTACK_DEPLOY_INTERVAL_MINUTES = 15;
export const DEFAULT_CATSTACK_DEPLOY_INTERVAL_MS = DEFAULT_CATSTACK_DEPLOY_INTERVAL_MINUTES * 60 * 1000;
export const DEFAULT_CATSTACK_REPO_URL = 'https://github.com/EdbertChan/catstack.git';
export const DEFAULT_CATSTACK_REPO_PATH = '~/Documents/GitHub/catstack';

export interface CatstackDeployTarget {
  name: string;
  connection: SshTargetConnection;
}

export interface CatstackDeployWorkerConfig {
  /** Poll cadence in milliseconds. Defaults to fifteen minutes. */
  intervalMs?: number;
  /** Git clone URL. Defaults to EdbertChan/catstack. */
  repoUrl?: string;
  /** Local checkout path (tilde expanded). Defaults to ~/Documents/GitHub/catstack. */
  localRepoPath?: string;
  /** Remote checkout path on each SSH host. Defaults to ~/Documents/GitHub/catstack. */
  remoteRepoPath?: string;
  remoteTargets?: CatstackDeployTarget[];
  tickOnStart?: boolean;
  store?: WorkerDecisionStore;
  /** Test seam: override local deploy. */
  deployLocal?: (repoPath: string, repoUrl: string) => Promise<void>;
  /** Test seam: override remote deploy. */
  deployRemote?: (target: CatstackDeployTarget, repoPath: string, repoUrl: string) => Promise<void>;
  onTick?: WorkerTick;
}

export interface CatstackDeployWorkerOptions {
  logger: Logger;
  intervalMs?: number;
  repoUrl: string;
  localRepoPath: string;
  remoteRepoPath: string;
  remoteTargets: CatstackDeployTarget[];
  tickOnStart?: boolean;
  store?: WorkerDecisionStore;
  deployLocal?: (repoPath: string, repoUrl: string) => Promise<void>;
  deployRemote?: (target: CatstackDeployTarget, repoPath: string, repoUrl: string) => Promise<void>;
  onTick?: WorkerTick;
}

/**
 * Expand a leading `~` for local filesystem paths. Remote paths keep `~` and
 * expand inside the SSH shell via bashNormalizeTildePath.
 */
export function expandLocalRepoPath(repoPath: string): string {
  const trimmed = repoPath.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

/**
 * Portable shell that clone-or-ff-only-pulls catstack then runs ./install.sh
 * with no --force / launchd extras. Dirty or diverged trees exit non-zero
 * before install.sh so the caller can skip that host.
 */
export function buildCatstackDeployScript(repoPath: string, repoUrl: string): string {
  const pathQ = shellPosixSingleQuote(repoPath);
  const urlQ = shellPosixSingleQuote(repoUrl);
  return `set -euo pipefail
REPO_PATH=${pathQ}
REPO_URL=${urlQ}
${bashNormalizeTildePath('REPO_PATH')}
if [ ! -d "$REPO_PATH/.git" ]; then
  mkdir -p "$(dirname "$REPO_PATH")"
  git clone "$REPO_URL" "$REPO_PATH"
else
  cd "$REPO_PATH"
  if [ -n "$(git status --porcelain)" ]; then
    echo "catstack-deploy: dirty working tree at $REPO_PATH; skipping install" >&2
    exit 1
  fi
  git fetch origin
  if git rev-parse --verify refs/remotes/origin/HEAD >/dev/null 2>&1; then
    DEFAULT_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')
  else
    git remote set-head origin -a
    DEFAULT_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')
  fi
  git checkout "$DEFAULT_BRANCH"
  git merge --ff-only "origin/$DEFAULT_BRANCH"
fi
cd "$REPO_PATH"
./install.sh
`;
}

function assertInstallHasNoForce(script: string): void {
  // Defense-in-depth for the safety invariant: install.sh must never receive --force.
  if (/(?:^|[\s;])\.\/install\.sh\s+[^\n]*--force\b/m.test(script)) {
    throw new Error('catstack-deploy: install.sh must not be invoked with --force');
  }
}

async function runLocalBashScript(script: string): Promise<void> {
  assertInstallHasNoForce(script);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('bash', ['-lc', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`local catstack deploy failed (exit=${code ?? 'unknown'}): ${stderr.trim() || 'no stderr'}`));
    });
  });
}

async function defaultDeployLocal(repoPath: string, repoUrl: string): Promise<void> {
  await runLocalBashScript(buildCatstackDeployScript(repoPath, repoUrl));
}

async function defaultDeployRemote(
  target: CatstackDeployTarget,
  repoPath: string,
  repoUrl: string,
): Promise<void> {
  const script = buildCatstackDeployScript(repoPath, repoUrl);
  assertInstallHasNoForce(script);
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  await execRemoteCapture({
    sshArgs,
    script,
    phase: `catstack-deploy:${target.name}`,
  });
}

function recordDecision(
  store: WorkerDecisionStore | undefined,
  subjectId: string,
  status: 'completed' | 'failed' | 'skipped',
  summary: string,
  payload: Record<string, unknown> = {},
): void {
  if (!store) return;
  recordWorkerDecisionRow(store, {
    workerKind: CATSTACK_DEPLOY_WORKER_KIND,
    actionType: 'catstack-deploy',
    externalKey: subjectId,
    subjectType: 'host',
    subjectId,
    status,
    summary,
    payload,
  });
}

export async function runCatstackDeployTick(options: CatstackDeployWorkerOptions): Promise<void> {
  const deployLocal = options.deployLocal ?? defaultDeployLocal;
  const deployRemote = options.deployRemote ?? defaultDeployRemote;
  const localPath = expandLocalRepoPath(options.localRepoPath);

  try {
    await deployLocal(localPath, options.repoUrl);
    recordDecision(options.store, 'local', 'completed', `Deployed catstack at ${localPath}`);
    options.logger.info(`[${CATSTACK_DEPLOY_WORKER_KIND}] local deploy ok`, {
      module: CATSTACK_DEPLOY_WORKER_KIND,
      path: localPath,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.logger.error(`[${CATSTACK_DEPLOY_WORKER_KIND}] local deploy failed: ${detail}`, {
      module: CATSTACK_DEPLOY_WORKER_KIND,
      path: localPath,
    });
    recordDecision(options.store, 'local', 'failed', `Local catstack deploy failed: ${detail}`);
  }

  for (const target of options.remoteTargets) {
    try {
      await deployRemote(target, options.remoteRepoPath, options.repoUrl);
      recordDecision(options.store, target.name, 'completed', `Deployed catstack on ${target.name}`);
      options.logger.info(`[${CATSTACK_DEPLOY_WORKER_KIND}] remote deploy ok`, {
        module: CATSTACK_DEPLOY_WORKER_KIND,
        target: target.name,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.logger.error(`[${CATSTACK_DEPLOY_WORKER_KIND}] remote deploy failed for ${target.name}: ${detail}`, {
        module: CATSTACK_DEPLOY_WORKER_KIND,
        target: target.name,
      });
      recordDecision(options.store, target.name, 'failed', `Remote catstack deploy failed: ${detail}`);
    }
  }
}

export function createCatstackDeployWorker(config: CatstackDeployWorkerConfig & { logger: Logger }): WorkerRuntime {
  const options: CatstackDeployWorkerOptions = {
    logger: config.logger,
    intervalMs: config.intervalMs,
    repoUrl: config.repoUrl ?? DEFAULT_CATSTACK_REPO_URL,
    localRepoPath: config.localRepoPath ?? DEFAULT_CATSTACK_REPO_PATH,
    remoteRepoPath: config.remoteRepoPath ?? DEFAULT_CATSTACK_REPO_PATH,
    remoteTargets: config.remoteTargets ?? [],
    tickOnStart: config.tickOnStart,
    store: config.store,
    deployLocal: config.deployLocal,
    deployRemote: config.deployRemote,
  };
  const onTick: WorkerTick = config.onTick ?? (async () => {
    await runCatstackDeployTick(options);
  });
  return createWorkerRuntime({
    kind: CATSTACK_DEPLOY_WORKER_KIND,
    logger: config.logger,
    onTick,
    intervalMs: config.intervalMs ?? DEFAULT_CATSTACK_DEPLOY_INTERVAL_MS,
    tickOnStart: config.tickOnStart ?? true,
  });
}

/** Register the built-in catstack-deploy worker. */
export function registerCatstackDeployWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CATSTACK_DEPLOY_WORKER_KIND,
    note: 'Clones or ff-only-pulls catstack and runs ./install.sh on the owner machine and every remoteTargets host.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createCatstackDeployWorker({
        logger: deps.logger,
        ...deps.catstackDeploy,
      }),
  });
  return registry;
}
