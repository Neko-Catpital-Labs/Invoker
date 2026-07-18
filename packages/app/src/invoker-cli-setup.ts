import type {
  BundledSkillsInstallMode,
  BundledSkillsStatus,
  CliInstallResult,
  InvokerSetupRequest,
  InvokerSetupResult,
  InvokerSetupStepResult,
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

function appendOutput(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next, 'utf8') <= MAX_SETUP_OUTPUT_BYTES) return next;
  return `${next.slice(0, MAX_SETUP_OUTPUT_BYTES)}\n[output truncated]`;
}

function runCli(cliPath: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CliCommandResult> {
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
