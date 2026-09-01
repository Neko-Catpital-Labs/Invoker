import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

export const OWNER_BOOTSTRAP_LOCK_DIR = 'headless-owner-bootstrap.lock';

export type OwnerRuntimeKind = 'packaged' | 'source-development';

const PACKAGED_KIND: OwnerRuntimeKind = 'packaged';
const SOURCE_DEVELOPMENT_KIND: OwnerRuntimeKind = 'source-development';

/**
 * Every environment variable that carries the parent's selected-profile
 * identity (database/config/log/socket locations and ports) for a
 * source-development run. This list must stay complete: a detached child
 * that inherits only part of it would silently bind some resources to the
 * source-development profile and others to production defaults.
 */
const SOURCE_DEVELOPMENT_PROFILE_KEYS = [
  'INVOKER_DEVELOPMENT_PROFILE',
  'INVOKER_DEVELOPMENT_PROFILE_ACTIVE',
  'INVOKER_SOURCE_ROOT',
  'INVOKER_PROFILE_ID',
  'INVOKER_DB_DIR',
  'INVOKER_USER_DATA_DIR',
  'INVOKER_IPC_SOCKET',
  'INVOKER_REPO_CONFIG_PATH',
  'INVOKER_ENV_PATH',
  'INVOKER_LOG_PATH',
  'INVOKER_API_PORT',
  'INVOKER_WEB_PORT',
] as const;

export class OwnerChildProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerChildProfileError';
  }
}

function determineOwnerParentRuntimeKind(parentEnv: NodeJS.ProcessEnv): OwnerRuntimeKind {
  const declaredKind = parentEnv.INVOKER_RUNTIME_KIND;
  if (declaredKind !== undefined && declaredKind !== PACKAGED_KIND && declaredKind !== SOURCE_DEVELOPMENT_KIND) {
    throw new OwnerChildProfileError(`Unknown Invoker runtime kind "${declaredKind}".`);
  }

  const developmentProfileActive = parentEnv.INVOKER_DEVELOPMENT_PROFILE === '1';
  if (declaredKind === PACKAGED_KIND && developmentProfileActive) {
    throw new OwnerChildProfileError(
      'INVOKER_RUNTIME_KIND=packaged contradicts INVOKER_DEVELOPMENT_PROFILE=1; refusing to spawn an owner child with a contradictory profile.',
    );
  }
  if (declaredKind === SOURCE_DEVELOPMENT_KIND && !developmentProfileActive) {
    throw new OwnerChildProfileError(
      'INVOKER_RUNTIME_KIND=source-development requires INVOKER_DEVELOPMENT_PROFILE=1; refusing to spawn an owner child with a contradictory profile.',
    );
  }

  return declaredKind === SOURCE_DEVELOPMENT_KIND || developmentProfileActive ? SOURCE_DEVELOPMENT_KIND : PACKAGED_KIND;
}

/**
 * Build the explicit, complete set of profile-identity environment
 * variables a detached owner child must receive from its parent. Throws
 * before the caller spawns anything when the parent's own settings are
 * partial or contradictory, rather than letting an incomplete inherited
 * `process.env` silently hand the child a mixed production/source-development
 * identity.
 */
export function resolveOwnerChildProfileEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const kind = determineOwnerParentRuntimeKind(parentEnv);

  if (kind === PACKAGED_KIND) {
    const stray = SOURCE_DEVELOPMENT_PROFILE_KEYS.filter((key) => Boolean(parentEnv[key]));
    if (stray.length > 0) {
      throw new OwnerChildProfileError(
        `Packaged parent has source-development settings set (${stray.join(', ')}); refusing to spawn an owner child with a contradictory profile.`,
      );
    }
    return { INVOKER_RUNTIME_KIND: PACKAGED_KIND };
  }

  const missing = SOURCE_DEVELOPMENT_PROFILE_KEYS.filter((key) => !parentEnv[key]);
  if (missing.length > 0) {
    throw new OwnerChildProfileError(
      `Source-development parent is missing required profile settings (${missing.join(', ')}); refusing to spawn an owner child with a partial profile.`,
    );
  }

  const childEnv: Record<string, string> = { INVOKER_RUNTIME_KIND: SOURCE_DEVELOPMENT_KIND };
  for (const key of SOURCE_DEVELOPMENT_PROFILE_KEYS) {
    childEnv[key] = parentEnv[key] as string;
  }
  return childEnv;
}

export type OwnerBootstrapLock = {
  lockDir: string;
  release: () => void;
};

type OwnerParentRuntime = {
  executablePath: string;
  isElectron: boolean;
  platform: NodeJS.Platform;
};

export function resolveDetachedOwnerCommand(
  repoRoot: string,
  runtime: OwnerParentRuntime = {
    executablePath: process.execPath,
    isElectron: Boolean(process.versions.electron),
    platform: process.platform,
  },
): { command: string; args: string[] } {
  const mainJs = resolve(repoRoot, 'packages', 'app', 'dist', 'main.js');
  const electronArgs = [
    ...(runtime.platform === 'linux' ? ['--no-sandbox'] : []),
    mainJs,
    '--headless',
    'owner-serve',
  ];

  if (runtime.isElectron) {
    return { command: runtime.executablePath, args: electronArgs };
  }

  return {
    command: runtime.executablePath,
    args: [resolve(repoRoot, 'scripts', 'electron.cjs'), ...electronArgs],
  };
}

export function tryAcquireOwnerBootstrapLock(invokerHomeRoot: string): OwnerBootstrapLock | null {
  const lockDir = join(invokerHomeRoot, OWNER_BOOTSTRAP_LOCK_DIR);

  try {
    mkdirSync(invokerHomeRoot, { recursive: true });
    mkdirSync(lockDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const pidFile = join(lockDir, 'pid');
    try {
      const holderPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (!Number.isNaN(holderPid)) {
        try {
          process.kill(holderPid, 0);
          return null;
        } catch {
          rmSync(lockDir, { recursive: true, force: true });
          return tryAcquireOwnerBootstrapLock(invokerHomeRoot);
        }
      }
      rmSync(lockDir, { recursive: true, force: true });
      return tryAcquireOwnerBootstrapLock(invokerHomeRoot);
    } catch {
      rmSync(lockDir, { recursive: true, force: true });
      return tryAcquireOwnerBootstrapLock(invokerHomeRoot);
    }
  }

  writeFileSync(join(lockDir, 'pid'), String(process.pid), 'utf8');
  let released = false;
  return {
    lockDir,
    release: () => {
      if (released) return;
      released = true;
      rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

export function spawnDetachedStandaloneOwner(
  repoRoot: string,
  extraEnv: NodeJS.ProcessEnv = {},
): void {
  const profileEnv = resolveOwnerChildProfileEnv(process.env);
  const childCommand = resolveDetachedOwnerCommand(repoRoot);
  const child = spawn(childCommand.command, childCommand.args, {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...extraEnv,
      ...profileEnv,
      INVOKER_HEADLESS_STANDALONE: '1',
      LIBGL_ALWAYS_SOFTWARE: process.platform === 'linux' ? '1' : process.env.LIBGL_ALWAYS_SOFTWARE,
    },
  });
  child.unref();
}
