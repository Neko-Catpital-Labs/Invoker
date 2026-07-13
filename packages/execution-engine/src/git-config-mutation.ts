import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export type GitConfigMutationKind =
  | 'config-write'
  | 'remote-add'
  | 'remote-set-url'
  | 'remote-remove'
  | 'remote-rename'
  | 'push-upstream'
  | 'branch-upstream';

export interface GitConfigMutationClassification {
  mutates: boolean;
  kind?: GitConfigMutationKind;
}

export interface GitConfigMutationContext {
  caller: string;
  detail?: string;
}

const repoLocks = new Map<string, Promise<void>>();

export function classifyGitConfigMutation(args: string[]): GitConfigMutationClassification {
  const command = firstNonOption(args);
  if (!command) return { mutates: false };

  if (command === 'config') {
    return classifyConfig(args.slice(args.indexOf(command) + 1));
  }

  if (command === 'remote') {
    const subcommand = firstNonOption(args.slice(args.indexOf(command) + 1));
    switch (subcommand) {
      case 'add':
        return { mutates: true, kind: 'remote-add' };
      case 'set-url':
        return { mutates: true, kind: 'remote-set-url' };
      case 'remove':
      case 'rm':
        return { mutates: true, kind: 'remote-remove' };
      case 'rename':
        return { mutates: true, kind: 'remote-rename' };
      default:
        return { mutates: false };
    }
  }

  if (command === 'push' && hasAnyArg(args, ['-u', '--set-upstream'])) {
    return { mutates: true, kind: 'push-upstream' };
  }

  if (command === 'branch' && hasBranchUpstreamMutation(args.slice(args.indexOf(command) + 1))) {
    return { mutates: true, kind: 'branch-upstream' };
  }

  return { mutates: false };
}

export function assertNotGitConfigMutation(args: string[], boundary: string): void {
  const classification = classifyGitConfigMutation(args);
  if (!classification.mutates) return;
  throw new Error(
    `${boundary} rejected git ${args.join(' ')} because it mutates .git/config ` +
      `(${classification.kind}). Use git-config-mutation gateway helpers instead.`,
  );
}

export async function ensureRemoteUrl(opts: {
  cwd: string;
  remote: string;
  url: string;
  context: GitConfigMutationContext;
}): Promise<'added' | 'updated' | 'unchanged'> {
  const expected = opts.url.trim();
  if (!expected) throw new Error('ensureRemoteUrl requires a non-empty URL');

  return withGitConfigMutationLock(opts.cwd, opts.context, async (lockInfo) => {
    const current = await runGit(['remote', 'get-url', opts.remote], opts.cwd)
      .then((value) => value.trim())
      .catch((err) => {
        if (isMissingRemoteError(err)) return undefined;
        throw err;
      });

    if (current === expected) {
      logGitConfigMutation({
        kind: 'remote-set-url',
        repo: lockInfo.repo,
        context: opts.context,
        retries: lockInfo.retries,
        durationMs: 0,
        result: 'noop',
      });
      return 'unchanged';
    }

    const start = performance.now();
    const kind: GitConfigMutationKind = current === undefined ? 'remote-add' : 'remote-set-url';
    try {
      if (current === undefined) {
        await runGit(['remote', 'add', opts.remote, expected], opts.cwd);
      } else {
        await runGit(['remote', 'set-url', opts.remote, expected], opts.cwd);
      }
      logGitConfigMutation({
        kind,
        repo: lockInfo.repo,
        context: opts.context,
        retries: lockInfo.retries,
        durationMs: performance.now() - start,
        result: 'success',
      });
      return current === undefined ? 'added' : 'updated';
    } catch (err) {
      logGitConfigMutation({
        kind,
        repo: lockInfo.repo,
        context: opts.context,
        retries: lockInfo.retries,
        durationMs: performance.now() - start,
        result: 'failed',
      });
      throw err;
    }
  });
}

export async function runGitConfigMutation(
  args: string[],
  cwd: string,
  context: GitConfigMutationContext,
): Promise<string> {
  const classification = classifyGitConfigMutation(args);
  if (!classification.mutates) {
    throw new Error(`runGitConfigMutation requires a config-mutating git command, got: git ${args.join(' ')}`);
  }

  return withGitConfigMutationLock(cwd, context, async (lockInfo) => {
    const start = performance.now();
    try {
      const result = await runGit(args, cwd);
      logGitConfigMutation({
        kind: classification.kind ?? 'config-write',
        repo: lockInfo.repo,
        context,
        retries: lockInfo.retries,
        durationMs: performance.now() - start,
        result: 'success',
      });
      return result;
    } catch (err) {
      logGitConfigMutation({
        kind: classification.kind ?? 'config-write',
        repo: lockInfo.repo,
        context,
        retries: lockInfo.retries,
        durationMs: performance.now() - start,
        result: 'failed',
      });
      throw err;
    }
  });
}

export async function withGitConfigMutationLock<T>(
  cwd: string,
  context: GitConfigMutationContext,
  fn: (lockInfo: { repo: string; retries: number }) => Promise<T>,
): Promise<T> {
  const repo = await resolveGitConfigRepoKey(cwd);
  const previous = repoLocks.get(repo) ?? Promise.resolve();
  let release!: () => void;
  const current = previous.then(() => new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  }));
  repoLocks.set(repo, current);

  await previous;
  let retries = 0;
  try {
    retries = await waitForExistingConfigLock(repo);
    return await fn({ repo, retries });
  } finally {
    release();
    if (repoLocks.get(repo) === current) repoLocks.delete(repo);
    if (retries > 0) {
      logGitConfigMutation({
        kind: 'config-write',
        repo,
        context,
        retries,
        durationMs: 0,
        result: 'lock-released',
      });
    }
  }
}

async function resolveGitConfigRepoKey(cwd: string): Promise<string> {
  try {
    const commonDir = (await runGit(['rev-parse', '--git-common-dir'], cwd)).trim();
    return isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  } catch {
    try {
      const gitDir = (await runGit(['rev-parse', '--git-dir'], cwd)).trim();
      return isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir);
    } catch {
      return resolve(cwd, '.git');
    }
  }
}

async function waitForExistingConfigLock(repo: string): Promise<number> {
  const configLock = resolve(repo, 'config.lock');
  let retries = 0;
  const deadline = Date.now() + 10_000;
  while (existsSync(configLock)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for existing git config lock: ${configLock}`);
    }
    retries++;
    await sleep(Math.min(50 * retries, 500));
  }
  return retries;
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => {
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(
        `git ${args.join(' ')} failed (code ${code}): ${stderr.trim()}${stdout.trim() ? '\n' + stdout.trim() : ''}`,
      ));
    });
  });
}

function classifyConfig(args: string[]): GitConfigMutationClassification {
  const readOnly = new Set([
    '--get',
    '--get-all',
    '--get-regexp',
    '--get-urlmatch',
    '--list',
    '-l',
    '--name-only',
    '--get-color',
    '--get-colorbool',
  ]);
  const writes = new Set([
    '--add',
    '--replace-all',
    '--unset',
    '--unset-all',
    '--rename-section',
    '--remove-section',
  ]);

  if (args.some((arg) => writes.has(arg))) return { mutates: true, kind: 'config-write' };
  if (args.some((arg) => readOnly.has(arg))) return { mutates: false };

  const positional = args.filter((arg) => !arg.startsWith('-'));
  if (positional.length >= 2) return { mutates: true, kind: 'config-write' };
  return { mutates: false };
}

function hasBranchUpstreamMutation(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--unset-upstream' || arg === '--set-upstream-to') return true;
    if (arg.startsWith('--set-upstream-to=')) return true;
    if (arg === '-u') return true;
  }
  return false;
}

function firstNonOption(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith('-'));
}

function hasAnyArg(args: string[], needles: string[]): boolean {
  return args.some((arg) => needles.includes(arg));
}

function isMissingRemoteError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /No such remote|No such remote '|No such remote:/i.test(msg);
}

function logGitConfigMutation(event: {
  kind: GitConfigMutationKind;
  repo: string;
  context: GitConfigMutationContext;
  retries: number;
  durationMs: number;
  result: string;
}): void {
  console.log(
    `[git-config-mutation] kind=${event.kind} repo=${event.repo} ` +
      `caller=${event.context.caller} detail=${event.context.detail ?? ''} ` +
      `retries=${event.retries} durationMs=${Math.round(event.durationMs)} result=${event.result}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
