import { accessSync, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

import {
  parseCursorListModelsOutput,
  type CursorDiscoveredModel,
} from '@invoker/contracts';
import { resolveExecutableOnCurrentPath } from '@invoker/execution-engine';

export const CURSOR_MODEL_DISCOVERY_TIMEOUT_MS = 4_000;
export const CURSOR_MODEL_DISCOVERY_CACHE_MS = 5 * 60_000;

const CURSOR_AGENT_BASENAME = 'cursor-agent';
const DETAIL_MAX_CHARS = 120;

export type CursorModelProbeResult = {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: NodeJS.ErrnoException;
  signal?: NodeJS.Signals | null;
};

export type CursorModelProbeRunner = (
  command: string,
  args: string[],
) => CursorModelProbeResult | Promise<CursorModelProbeResult>;

export type CursorModelDiscoveryOutcome =
  | { kind: 'ok'; models: readonly CursorDiscoveredModel[] }
  | { kind: 'empty' }
  | { kind: 'failed'; reason: string };

type CacheEntry =
  | { kind: 'ok'; expiresAt: number; models: readonly CursorDiscoveredModel[] }
  | { kind: 'empty'; expiresAt: number }
  | { kind: 'failed'; expiresAt: number; reason: string };

let sessionCache: CacheEntry | undefined;
let probeRunnerOverride: CursorModelProbeRunner | undefined;

export function setCursorModelProbeRunnerForTests(
  runner: CursorModelProbeRunner | undefined,
): void {
  probeRunnerOverride = runner;
}

export function clearCursorModelDiscoveryCacheForTests(): void {
  sessionCache = undefined;
}

function boundDetail(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length > DETAIL_MAX_CHARS
    ? `${collapsed.slice(0, DETAIL_MAX_CHARS)}...`
    : collapsed;
}

function defaultProbeRunner(command: string, args: string[]): Promise<CursorModelProbeResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result: CursorModelProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        status: null,
        stdout,
        stderr,
        error: undefined,
        signal: 'SIGKILL',
      });
    }, CURSOR_MODEL_DISCOVERY_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        status: null,
        stdout,
        stderr,
        error,
        signal: null,
      });
    });
    child.on('close', (status, signal) => {
      finish({
        status,
        stdout,
        stderr,
        error: undefined,
        signal: (signal as NodeJS.Signals | null) ?? null,
      });
    });
  });
}

function resolveListModelsInvocation(
  plannerCommand: string,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } | undefined {
  const base = basename(plannerCommand);
  if (base === CURSOR_AGENT_BASENAME || base === `${CURSOR_AGENT_BASENAME}.exe`) {
    const resolved = resolveExecutableOnCurrentPath(plannerCommand) ?? plannerCommand;
    return { command: resolved, args: ['--list-models'] };
  }

  const fromPath = resolveExecutableOnCurrentPath(CURSOR_AGENT_BASENAME);
  if (fromPath) return { command: fromPath, args: ['--list-models'] };

  const home = env.HOME?.trim() || homedir();
  const localBin = join(home, '.local', 'bin', CURSOR_AGENT_BASENAME);
  try {
    accessSync(localBin, constants.X_OK);
    return { command: localBin, args: ['--list-models'] };
  } catch {
  }

  const wrapper = resolveExecutableOnCurrentPath(plannerCommand)
    ?? resolveExecutableOnCurrentPath('cursor')
    ?? (base === 'cursor' || base === 'cursor.exe' ? plannerCommand : undefined);
  if (!wrapper) return undefined;
  return { command: wrapper, args: ['agent', '--list-models'] };
}

function describeProbeFailure(result: CursorModelProbeResult): string {
  if (result.error) {
    const code = result.error.code;
    return boundDetail(`failed to run (${code ?? result.error.message})`);
  }
  if (result.signal === 'SIGKILL' || result.signal === 'SIGTERM') {
    return boundDetail('timed out');
  }
  if (result.signal) return boundDetail(`was terminated by ${result.signal}`);
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/not logged in|authentication required|unauthorized|login required/i.test(combined)) {
    return boundDetail('authentication required');
  }
  return boundDetail(`exited with status ${result.status}`);
}

async function runDiscovery(plannerCommand: string): Promise<CursorModelDiscoveryOutcome> {
  const resolved = resolveListModelsInvocation(plannerCommand);
  if (!resolved) {
    return { kind: 'failed', reason: 'Cursor Agent CLI was not found on PATH' };
  }
  const runner = probeRunnerOverride ?? defaultProbeRunner;
  const result = await runner(resolved.command, resolved.args);
  if (result.error || result.status !== 0) {
    return { kind: 'failed', reason: describeProbeFailure(result) };
  }
  const parsed = parseCursorListModelsOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (parsed.kind === 'invalid') {
    return { kind: 'failed', reason: boundDetail(`unusable list-models output (${parsed.reason})`) };
  }
  if (parsed.kind === 'empty') return { kind: 'empty' };
  return { kind: 'ok', models: parsed.models };
}

export async function discoverCursorPlanningModels(options?: {
  plannerCommand?: string;
  refresh?: boolean;
  now?: number;
}): Promise<CursorModelDiscoveryOutcome> {
  const now = options?.now ?? Date.now();
  if (!options?.refresh && sessionCache && sessionCache.expiresAt > now) {
    if (sessionCache.kind === 'ok') return { kind: 'ok', models: sessionCache.models };
    if (sessionCache.kind === 'empty') return { kind: 'empty' };
    return { kind: 'failed', reason: sessionCache.reason };
  }

  const outcome = await runDiscovery(options?.plannerCommand ?? 'cursor');
  const expiresAt = now + CURSOR_MODEL_DISCOVERY_CACHE_MS;
  if (outcome.kind === 'ok') {
    sessionCache = { kind: 'ok', expiresAt, models: outcome.models };
  } else if (outcome.kind === 'empty') {
    sessionCache = { kind: 'empty', expiresAt };
  } else {
    sessionCache = { kind: 'failed', expiresAt, reason: outcome.reason };
  }
  return outcome;
}
