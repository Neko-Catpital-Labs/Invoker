import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runInvokerCliSetup, runMachinesSetup, type MachineSetupInput } from '../invoker-cli-setup.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeCli(script: string): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-cli-setup-'));
  tempRoots.push(root);
  const cliPath = join(root, 'invoker-cli.js');
  writeFileSync(cliPath, script);
  return cliPath;
}

function makeDeps(cliPath: string) {
  return {
    cliPath,
    updateCli: vi.fn(() => ({ ok: true, updated: true, installedTo: '/tmp/invoker-cli', status: { supported: true, bundledVersion: '1.0.0', upToDate: true } })),
    installBundledSkills: vi.fn(() => ({
      available: true,
      promptRecommended: false,
      managedPrefix: 'invoker-',
      bundledSkillNames: ['plan-to-invoker'],
      targets: [{ id: 'codex', name: 'Codex', path: '/tmp/skills', available: true, installed: true, upToDate: true, installedSkillNames: ['invoker-plan-to-invoker'] }],
      commandTargets: [],
      mcpTargets: [],
    })),
  };
}

describe('runInvokerCliSetup', () => {
  it('runs checked setup steps and passes Slack values through env', async () => {
    const cliPath = makeCli(`
const args = process.argv.slice(2).join(' ');
if (args === 'doctor --fix') process.stdout.write('doctor fixed');
else if (args === 'setup slack --from-env' && process.env.SLACK_BOT_TOKEN === 'xoxb-token') process.stdout.write('slack saved');
else process.exit(9);
`);
    const deps = makeDeps(cliPath);

    const result = await runInvokerCliSetup({
      updateCli: true,
      installHelpers: true,
      fixTools: true,
      slack: { botToken: 'xoxb-token', appToken: 'xapp-token', signingSecret: 'secret', channelId: 'C123' },
    }, deps);

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.id)).toEqual(['invoker-cli', 'helpers', 'tools', 'slack']);
    expect(result.steps.find((step) => step.id === 'tools')?.output).toContain('doctor fixed');
    expect(result.steps.find((step) => step.id === 'slack')?.output).toContain('slack saved');
    expect(deps.updateCli).toHaveBeenCalledTimes(1);
    expect(deps.installBundledSkills).toHaveBeenCalledWith('install');
  });

  it('continues after a selected setup step fails', async () => {
    const cliPath = makeCli(`
const args = process.argv.slice(2).join(' ');
if (args === 'doctor --fix') { process.stderr.write('bad setup'); process.exit(7); }
if (args === 'setup slack --from-env') process.stdout.write('slack still ran');
`);
    const deps = makeDeps(cliPath);

    const result = await runInvokerCliSetup({
      updateCli: false,
      installHelpers: false,
      fixTools: true,
      slack: { botToken: 'xoxb-token', appToken: 'xapp-token', signingSecret: 'secret', channelId: 'C123' },
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.steps.map((step) => step.id)).toEqual(['tools', 'slack']);
    expect(result.steps[0]).toMatchObject({ ok: false });
    expect(result.steps[1]).toMatchObject({ ok: true });
  });
});

const SECRET_SSH_KEY_PATH = '/home/deploy/.ssh/id_ed25519_dabf3d8c';

function machineInputs(): MachineSetupInput[] {
  return [
    { host: 'build-1.internal', user: 'deploy', sshKeyPath: SECRET_SSH_KEY_PATH, port: 2222 },
    { host: 'build-2.internal', user: 'deploy', sshKeyPath: SECRET_SSH_KEY_PATH },
  ];
}

describe('runMachinesSetup', () => {
  it('reads machine fields from stdin and returns one result per machine', async () => {
    const cliPath = makeCli(`
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  if (process.argv.slice(2).join(' ') !== 'setup machines --json') process.exit(9);
  const machines = JSON.parse(data);
  const results = machines.map((m) => ({
    id: m.id || m.host,
    host: m.host,
    reachable: true,
    detail: 'ssh probe ok',
    written: true,
  }));
  process.stdout.write(JSON.stringify(results));
});
`);
    const deps = makeDeps(cliPath);

    const results = await runMachinesSetup(machineInputs(), deps);

    expect(results).toEqual([
      { host: 'build-1.internal', ok: true, reachable: true, written: true, detail: 'ssh probe ok' },
      { host: 'build-2.internal', ok: true, reachable: true, written: true, detail: 'ssh probe ok' },
    ]);
  });

  it('returns an error result per machine when the child process fails', async () => {
    const cliPath = makeCli(`
process.stderr.write('boom');
process.exit(3);
`);
    const deps = makeDeps(cliPath);

    const results = await runMachinesSetup(machineInputs(), deps);

    expect(results).toEqual([
      { host: 'build-1.internal', ok: false, error: 'invoker-cli exited with 3' },
      { host: 'build-2.internal', ok: false, error: 'invoker-cli exited with 3' },
    ]);
  });

  it('never writes machine field values to console output', async () => {
    const cliPath = makeCli(`
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  const machines = JSON.parse(data);
  const results = machines.map((m) => ({ id: m.host, host: m.host, reachable: true, detail: 'ok', written: true }));
  process.stdout.write(JSON.stringify(results));
});
`);
    const deps = makeDeps(cliPath);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runMachinesSetup(machineInputs(), deps);
    } finally {
      const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join('\n');
      expect(allLoggedText).not.toContain(SECRET_SSH_KEY_PATH);
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
