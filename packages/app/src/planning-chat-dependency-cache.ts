import { execFile } from 'node:child_process';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { resolveInvokerHomeRoot } from '@invoker/contracts';

const execFileAsync = promisify(execFile);

export const PLANNING_WORKTREE_INSTALL_ARGS = ['install', '--frozen-lockfile', '--ignore-scripts'] as const;
export const PLANNING_WORKTREE_INSTALL_TIMEOUT_MS = 120_000;

const CACHE_SCHEMA_VERSION = 1;
const PNPM_VERSION_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = PLANNING_WORKTREE_INSTALL_TIMEOUT_MS + 30_000;
const STALE_TMP_ENTRY_MS = 24 * 60 * 60 * 1000;
const MAX_TMP_ENTRY_CLEANUPS = 20;

interface PlanningDependencyCompatibilityKey {
  schemaVersion: number;
  lockfileSha256: string;
  packageManager: string;
  pnpmVersion: string;
  nodeAbi: string;
  nodeMajor: string;
  platform: string;
  arch: string;
  installArgs: readonly string[];
}

interface PlanningDependencyManifest {
  schemaVersion: number;
  key: string;
  compatibility: PlanningDependencyCompatibilityKey;
  createdAt: string;
}

export interface PlanningDependencyPreparationOptions {
  cacheRoot?: string;
}

export interface PlanningDependencyPreparationResult {
  status: 'hit' | 'miss-installed' | 'miss-install-failed' | 'skipped';
  cacheKey?: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function cacheRootForPlanningDependencies(options?: PlanningDependencyPreparationOptions): string {
  return options?.cacheRoot
    ?? process.env.INVOKER_PLANNING_NODE_MODULES_CACHE_DIR
    ?? join(resolveInvokerHomeRoot(), 'planning-node-modules-cache');
}

async function readPnpmVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('pnpm', ['--version'], {
      timeout: PNPM_VERSION_TIMEOUT_MS,
    });
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readPackageManager(worktreePath: string): string {
  const packageJsonPath = join(worktreePath, 'package.json');
  if (!existsSync(packageJsonPath)) return 'unknown';
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { packageManager?: unknown };
    return typeof parsed.packageManager === 'string' && parsed.packageManager.trim()
      ? parsed.packageManager.trim()
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function buildCompatibilityKey(worktreePath: string): Promise<PlanningDependencyCompatibilityKey | undefined> {
  const lockfilePath = join(worktreePath, 'pnpm-lock.yaml');
  if (!existsSync(lockfilePath)) return undefined;
  const lockfile = readFileSync(lockfilePath);
  const nodeMajor = process.versions.node.split('.')[0] ?? 'unknown';
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    lockfileSha256: sha256(lockfile),
    packageManager: readPackageManager(worktreePath),
    pnpmVersion: await readPnpmVersion(),
    nodeAbi: process.versions.modules ?? 'unknown',
    nodeMajor,
    platform: process.platform,
    arch: process.arch,
    installArgs: PLANNING_WORKTREE_INSTALL_ARGS,
  };
}

function cacheKeyFor(compatibility: PlanningDependencyCompatibilityKey): string {
  return sha256(stableJson(compatibility));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function entryPath(cacheRoot: string, key: string): string {
  return join(cacheRoot, 'entries', key);
}

function lockPath(cacheRoot: string, key: string): string {
  return join(cacheRoot, 'locks', `${key}.lock`);
}

function nodeModulesPath(path: string): string {
  return join(path, 'node_modules');
}

function readManifest(path: string): PlanningDependencyManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as PlanningDependencyManifest;
  } catch {
    return undefined;
  }
}

function manifestMatches(
  manifest: PlanningDependencyManifest | undefined,
  key: string,
  compatibility: PlanningDependencyCompatibilityKey,
): boolean {
  const cached = manifest?.compatibility;
  return !!manifest
    && manifest.schemaVersion === CACHE_SCHEMA_VERSION
    && manifest.key === key
    && cached?.schemaVersion === compatibility.schemaVersion
    && cached.lockfileSha256 === compatibility.lockfileSha256
    && cached.packageManager === compatibility.packageManager
    && cached.pnpmVersion === compatibility.pnpmVersion
    && cached.nodeAbi === compatibility.nodeAbi
    && cached.nodeMajor === compatibility.nodeMajor
    && cached.platform === compatibility.platform
    && cached.arch === compatibility.arch
    && Array.isArray(cached.installArgs)
    && cached.installArgs.length === compatibility.installArgs.length
    && cached.installArgs.every((arg, index) => arg === compatibility.installArgs[index]);
}

function validEntry(path: string, key: string, compatibility: PlanningDependencyCompatibilityKey): boolean {
  return existsSync(nodeModulesPath(path))
    && manifestMatches(readManifest(path), key, compatibility);
}

async function acquireCacheLock(cacheRoot: string, key: string): Promise<() => void> {
  const path = lockPath(cacheRoot, key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  while (true) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, 'owner.json'), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }), 'utf8');
      return () => {
        rmSync(path, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for planning dependency cache lock ${path}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

function copyTreeCloneFirst(source: string, target: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true, mode: stat.mode });
    for (const entry of readdirSync(source)) {
      copyTreeCloneFirst(join(source, entry), join(target, entry));
    }
    return;
  }
  copyFileSync(source, target, fsConstants.COPYFILE_FICLONE);
}

function materializeNodeModules(sourceNodeModules: string, targetWorktreePath: string): void {
  const target = nodeModulesPath(targetWorktreePath);
  const tmp = join(targetWorktreePath, `.node_modules.tmp-${process.pid}-${randomUUID()}`);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
  try {
    copyTreeCloneFirst(sourceNodeModules, tmp);
    if (!existsSync(tmp)) {
      throw new Error(`Copied node_modules tree missing at ${tmp}`);
    }
    renameSync(tmp, target);
    if (!existsSync(target)) {
      throw new Error(`Materialized node_modules tree missing at ${target}`);
    }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function publishSnapshot(
  worktreePath: string,
  cacheRoot: string,
  key: string,
  compatibility: PlanningDependencyCompatibilityKey,
): void {
  const sourceNodeModules = nodeModulesPath(worktreePath);
  if (!existsSync(sourceNodeModules)) return;

  const entriesRoot = join(cacheRoot, 'entries');
  mkdirSync(entriesRoot, { recursive: true, mode: 0o700 });
  const finalPath = entryPath(cacheRoot, key);
  if (validEntry(finalPath, key, compatibility)) return;
  rmSync(finalPath, { recursive: true, force: true });

  const tmpPath = join(entriesRoot, `${key}.tmp-${process.pid}-${randomUUID()}`);
  rmSync(tmpPath, { recursive: true, force: true });
  try {
    mkdirSync(tmpPath, { recursive: true, mode: 0o700 });
    copyTreeCloneFirst(sourceNodeModules, nodeModulesPath(tmpPath));
    const manifest: PlanningDependencyManifest = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      key,
      compatibility,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(tmpPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, finalPath);
  } catch (error) {
    rmSync(tmpPath, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function cleanupStaleTemporaryEntries(cacheRoot: string): void {
  const entriesRoot = join(cacheRoot, 'entries');
  if (!existsSync(entriesRoot)) return;
  let removed = 0;
  const now = Date.now();
  for (const name of readdirSync(entriesRoot)) {
    if (removed >= MAX_TMP_ENTRY_CLEANUPS || !name.includes('.tmp-')) break;
    const path = join(entriesRoot, name);
    try {
      const stat = lstatSync(path);
      if (now - stat.mtimeMs < STALE_TMP_ENTRY_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* best-effort cache hygiene only */
    }
  }
}

async function runBestEffortInstall(worktreePath: string): Promise<boolean> {
  try {
    await execFileAsync('pnpm', [...PLANNING_WORKTREE_INSTALL_ARGS], {
      cwd: worktreePath,
      timeout: PLANNING_WORKTREE_INSTALL_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    console.warn(
      `[planning-chat-worktree] pnpm install --frozen-lockfile --ignore-scripts failed in ${worktreePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function tryMaterializeHit(
  worktreePath: string,
  cacheRoot: string,
  key: string,
  compatibility: PlanningDependencyCompatibilityKey,
): Promise<boolean> {
  const path = entryPath(cacheRoot, key);
  if (!validEntry(path, key, compatibility)) return false;
  materializeNodeModules(nodeModulesPath(path), worktreePath);
  return true;
}

export async function preparePlanningWorktreeDependencies(
  worktreePath: string,
  options?: PlanningDependencyPreparationOptions,
): Promise<PlanningDependencyPreparationResult> {
  const compatibility = await buildCompatibilityKey(worktreePath);
  if (!compatibility) {
    const installed = await runBestEffortInstall(worktreePath);
    return { status: installed ? 'miss-installed' : 'miss-install-failed' };
  }

  const key = cacheKeyFor(compatibility);
  const cacheRoot = cacheRootForPlanningDependencies(options);
  try {
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    cleanupStaleTemporaryEntries(cacheRoot);
    if (await tryMaterializeHit(worktreePath, cacheRoot, key, compatibility)) {
      return { status: 'hit', cacheKey: key };
    }

    const release = await acquireCacheLock(cacheRoot, key);
    try {
      if (await tryMaterializeHit(worktreePath, cacheRoot, key, compatibility)) {
        return { status: 'hit', cacheKey: key };
      }
      const installed = await runBestEffortInstall(worktreePath);
      if (!installed) return { status: 'miss-install-failed', cacheKey: key };
      try {
        publishSnapshot(worktreePath, cacheRoot, key, compatibility);
      } catch (error) {
        console.warn(
          `[planning-chat-worktree] dependency cache publish failed in ${worktreePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return { status: 'miss-installed', cacheKey: key };
    } finally {
      release();
    }
  } catch (error) {
    console.warn(
      `[planning-chat-worktree] dependency cache failed in ${worktreePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const installed = await runBestEffortInstall(worktreePath);
    return { status: installed ? 'miss-installed' : 'miss-install-failed', cacheKey: key };
  }
}
