import type {
  BundledSkillsInstallMode,
  BundledSkillsStatus,
  CliInstallResult,
  InvokerSetupRequest,
  InvokerSetupResult,
  InvokerSetupStepResult,
  RemoteTargetInput,
} from '@invoker/contracts';

import { spawnBundledCli } from './cli-helper.js';

const MAX_SETUP_OUTPUT_BYTES = 64 * 1024;

export interface InvokerCliSetupDeps {
  cliPath: string;
  updateCli: () => CliInstallResult;
  installBundledSkills: (mode?: BundledSkillsInstallMode) => BundledSkillsStatus;
}

interface CliCommandResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  error?: string;
}

export interface MachineSetupResult {
  name?: string;
  reachable?: boolean;
  written: boolean;
  message: string;
  error?: {
    code: string;
    message: string;
    conflictingTargetId?: string;
  };
}

function appendOutput(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next, 'utf8') <= MAX_SETUP_OUTPUT_BYTES) return next;
  return `${next.slice(0, MAX_SETUP_OUTPUT_BYTES)}\n[output truncated]`;
}

function runCli(cliPath: string, args: string[], env?: NodeJS.ProcessEnv, stdinInput?: string): Promise<CliCommandResult> {
  const { promise, resolve } = Promise.withResolvers<CliCommandResult>();
  let stdout = '';
  let stderr = '';
  let settled = false;
  const settle = (result: CliCommandResult): void => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  try {
    const child = spawnBundledCli(cliPath, args, { env });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      settle({ ok: false, exitCode: null, output: [stdout, stderr].filter(Boolean).join('\n'), error: message });
    });
    child.on('close', (exitCode) => {
      const output = [stdout, stderr].filter(Boolean).join('\n');
      settle({ ok: exitCode === 0, exitCode, output, error: exitCode === 0 ? undefined : `invoker-cli exited with ${exitCode}` });
    });
    if (stdinInput !== undefined) {
      child.stdin?.write(stdinInput);
    }
    child.stdin?.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    settle({ ok: false, exitCode: null, output: '', error: message });
  }

  return promise;
}

function summarizeCliInstall(result: CliInstallResult): string {
  if (!result.ok) return result.error ?? 'invoker-cli install failed.';
  const action = result.updated ? 'Installed' : 'Already installed';
  return `${action} invoker-cli${result.installedTo ? ` at ${result.installedTo}` : ''}.`;
}

function summarizeHelpers(status: BundledSkillsStatus): string {
  const targets = [...status.targets, ...status.commandTargets, ...status.mcpTargets];
  const installed = targets.filter((target) => target.installed && target.upToDate).length;
  return `Installed ${status.bundledSkillNames.length} bundled helper set(s) across ${installed}/${targets.length} available target(s).`;
}

function machinesErrorResult(machines: RemoteTargetInput[], message: string): MachineSetupResult[] {
  return machines.map(() => ({
    written: false,
    message,
    error: { code: 'invoker-cli-failed', message },
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMachineSetupError(value: unknown): value is MachineSetupResult['error'] {
  if (!isRecord(value)) return false;
  if (typeof value.code !== 'string' || typeof value.message !== 'string') return false;
  return value.conflictingTargetId === undefined || typeof value.conflictingTargetId === 'string';
}

function isMachineSetupResult(value: unknown): value is MachineSetupResult {
  if (!isRecord(value)) return false;
  if (typeof value.written !== 'boolean' || typeof value.message !== 'string') return false;
  if (value.name !== undefined && typeof value.name !== 'string') return false;
  if (value.reachable !== undefined && typeof value.reachable !== 'boolean') return false;
  return value.error === undefined || isMachineSetupError(value.error);
}

export async function runMachinesSetup(
  machines: RemoteTargetInput[],
  deps: Pick<InvokerCliSetupDeps, 'cliPath'>,
): Promise<MachineSetupResult[]> {
  const result = await runCli(deps.cliPath, ['setup', 'machines', '--json'], undefined, JSON.stringify(machines));

  if (!result.ok) {
    return machinesErrorResult(machines, result.error ?? 'invoker-cli exited with an error');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output);
  } catch {
    return machinesErrorResult(machines, 'invoker-cli returned unparsable output');
  }

  if (!Array.isArray(parsed)) {
    return machinesErrorResult(machines, 'invoker-cli returned unexpected output');
  }

  if (parsed.length !== machines.length || !parsed.every(isMachineSetupResult)) {
    return machinesErrorResult(machines, 'invoker-cli returned invalid machine setup output');
  }

  return parsed as MachineSetupResult[];
}

export async function runInvokerCliSetup(request: InvokerSetupRequest, deps: InvokerCliSetupDeps): Promise<InvokerSetupResult> {
  const steps: InvokerSetupStepResult[] = [];

  if (request.updateCli) {
    const result = deps.updateCli();
    steps.push({
      id: 'invoker-cli',
      name: 'Install invoker-cli',
      ok: result.ok,
      output: summarizeCliInstall(result),
      error: result.ok ? undefined : result.error,
    });
  }

  if (request.installHelpers) {
    try {
      const status = deps.installBundledSkills('install');
      steps.push({ id: 'helpers', name: 'Install helpers', ok: true, output: summarizeHelpers(status) });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      steps.push({ id: 'helpers', name: 'Install helpers', ok: false, output: '', error });
    }
  }

  if (request.fixTools) {
    const result = await runCli(deps.cliPath, ['doctor', '--fix']);
    steps.push({ id: 'tools', name: 'Install missing tools', ok: result.ok, output: result.output, error: result.error });
  }

  if (request.slack) {
    const result = await runCli(deps.cliPath, ['setup', 'slack', '--from-env'], {
      SLACK_BOT_TOKEN: request.slack.botToken,
      SLACK_APP_TOKEN: request.slack.appToken,
      SLACK_SIGNING_SECRET: request.slack.signingSecret,
      SLACK_CHANNEL_ID: request.slack.channelId,
    });
    steps.push({ id: 'slack', name: 'Set up Slack', ok: result.ok, output: result.output, error: result.error });
  }

  return { ok: steps.every((step) => step.ok), steps };
}
