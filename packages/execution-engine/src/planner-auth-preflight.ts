import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  buildPlannerAuthRequiredError,
  plannerOutputIndicatesAuthFailure,
  plannerOutputIndicatesAuthLimbo,
} from './agent-auth-failure.js';
import {
  childProcessHasExited,
  resolveExecutableOnCurrentPath,
  terminateChildProcessGroup,
} from './process-utils.js';

export type PlannerAuthPreflightStatus =
  | 'authenticated'
  | 'unauthenticated'
  | 'unknown'
  | 'unsupported';

export type PlannerAuthPreflightHarness = 'claude' | 'codex' | 'cursor';

export interface PlannerAuthPreflightResult {
  readonly status: PlannerAuthPreflightStatus;
  readonly harness: string;
  readonly detail?: string;
}

export interface PlannerAuthPreflightCommandResult {
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  readonly spawnError?: string;
}

export type PlannerAuthPreflightCommandRunner = (request: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
}) => Promise<PlannerAuthPreflightCommandResult>;

export const PLANNER_AUTH_PREFLIGHT_TIMEOUT_MS = 5_000;

const CURSOR_AGENT_BASENAME = 'cursor-agent';

export function resolvePlannerAuthPreflightHarness(
  tool: string | undefined,
): PlannerAuthPreflightHarness | 'unsupported' {
  const key = (tool ?? '').trim().toLowerCase();
  // Cursor presets own the CLI auth gate even when a model suffix is present
  // (e.g. cursor+codex). Check cursor before +codex/+claude suffixes.
  if (key === 'cursor' || key.startsWith('cursor')) return 'cursor';
  if (key === 'claude' || key.endsWith('+claude') || key.startsWith('claude')) return 'claude';
  if (key === 'codex' || key.endsWith('+codex') || key.startsWith('codex')) return 'codex';
  return 'unsupported';
}

export function interpretClaudeAuthStatusOutput(output: string): PlannerAuthPreflightStatus {
  const jsonText = extractJsonObject(output);
  if (!jsonText) return 'unknown';
  try {
    const parsed = JSON.parse(jsonText) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn !== 'boolean') return 'unknown';
    return parsed.loggedIn ? 'authenticated' : 'unauthenticated';
  } catch {
    return 'unknown';
  }
}

export function interpretCodexLoginStatus(result: {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}): PlannerAuthPreflightStatus {
  if (result.timedOut) return 'unknown';
  if (plannerOutputIndicatesAuthFailure(result.output)) return 'unauthenticated';
  if (result.exitCode === 0) return 'authenticated';
  return 'unknown';
}

export function interpretCursorAuthStatus(result: {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}): PlannerAuthPreflightStatus {
  if (plannerOutputIndicatesAuthFailure(result.output) || plannerOutputIndicatesAuthLimbo(result.output)) {
    return 'unauthenticated';
  }
  if (result.timedOut) return 'unknown';
  if (result.exitCode === 0) return 'authenticated';
  return 'unknown';
}

export function buildPlannerAuthPreflightArgs(
  harness: PlannerAuthPreflightHarness,
): string[] {
  switch (harness) {
    case 'claude':
      return ['auth', 'status'];
    case 'codex':
      return ['login', 'status'];
    case 'cursor':
      return ['status'];
  }
}

export function resolvePlannerAuthPreflightExecutable(options: {
  harness: PlannerAuthPreflightHarness;
  plannerCommand: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = options.env ?? process.env;
  if (options.harness === 'cursor') {
    return resolveCursorAgentExecutable(options.plannerCommand, env);
  }
  const resolved = resolveExecutableOnCurrentPath(options.plannerCommand);
  return resolved ?? (options.plannerCommand.includes('/') || options.plannerCommand.includes('\\')
    ? options.plannerCommand
    : undefined);
}

function resolveCursorAgentExecutable(
  plannerCommand: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const base = basename(plannerCommand);
  if (base === CURSOR_AGENT_BASENAME || base === `${CURSOR_AGENT_BASENAME}.exe`) {
    return resolveExecutableOnCurrentPath(plannerCommand) ?? plannerCommand;
  }
  const fromPath = resolveExecutableOnCurrentPath(CURSOR_AGENT_BASENAME);
  if (fromPath) return fromPath;
  const home = env.HOME?.trim() || homedir();
  const localBin = join(home, '.local', 'bin', CURSOR_AGENT_BASENAME);
  try {
    accessSync(localBin, constants.X_OK);
    return localBin;
  } catch {
    return undefined;
  }
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

export async function defaultPlannerAuthPreflightRunner(request: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
}): Promise<PlannerAuthPreflightCommandResult> {
  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let output = '';
    let child: ChildProcess;
    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({
        exitCode: null,
        output: '',
        timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const finish = (result: PlannerAuthPreflightCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      void terminateChildProcessGroup(child, () => childProcessHasExited(child) || settled);
      finish({ exitCode: child.exitCode, output, timedOut: true });
    }, request.timeoutMs);

    const append = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (error) => {
      finish({
        exitCode: null,
        output,
        timedOut: false,
        spawnError: error.message,
      });
    });
    child.on('close', (code) => {
      finish({
        exitCode: code,
        output,
        timedOut,
      });
    });
  });
}

export async function runPlannerAuthPreflight(options: {
  tool: string | undefined;
  plannerCommand: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  runner?: PlannerAuthPreflightCommandRunner;
}): Promise<PlannerAuthPreflightResult> {
  const harness = resolvePlannerAuthPreflightHarness(options.tool);
  if (harness === 'unsupported') {
    return { status: 'unsupported', harness: options.tool ?? 'unknown' };
  }

  const env = options.env ?? { ...process.env };
  const executable = resolvePlannerAuthPreflightExecutable({
    harness,
    plannerCommand: options.plannerCommand,
    env,
  });
  const runner = options.runner ?? defaultPlannerAuthPreflightRunner;
  // Injected runners (tests) may supply outcomes without a real binary on PATH.
  if (!executable && !options.runner) {
    return {
      status: 'unknown',
      harness,
      detail: `preflight executable not found for ${harness}`,
    };
  }

  const commandResult = await runner({
    command: executable ?? options.plannerCommand,
    args: buildPlannerAuthPreflightArgs(harness),
    env,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? PLANNER_AUTH_PREFLIGHT_TIMEOUT_MS,
  });

  if (commandResult.spawnError) {
    return {
      status: 'unknown',
      harness,
      detail: commandResult.spawnError,
    };
  }

  const status = interpretHarnessPreflight(harness, commandResult);
  return {
    status,
    harness,
    detail: commandResult.timedOut
      ? `preflight timed out after ${options.timeoutMs ?? PLANNER_AUTH_PREFLIGHT_TIMEOUT_MS}ms`
      : undefined,
  };
}

function interpretHarnessPreflight(
  harness: PlannerAuthPreflightHarness,
  result: PlannerAuthPreflightCommandResult,
): PlannerAuthPreflightStatus {
  switch (harness) {
    case 'claude':
      if (result.timedOut) return 'unknown';
      return interpretClaudeAuthStatusOutput(result.output);
    case 'codex':
      return interpretCodexLoginStatus(result);
    case 'cursor':
      return interpretCursorAuthStatus(result);
  }
}

export function throwIfPlannerAuthPreflightUnauthenticated(
  result: PlannerAuthPreflightResult,
  plannerLabel: string,
): void {
  if (result.status !== 'unauthenticated') return;
  throw buildPlannerAuthRequiredError(plannerLabel);
}
