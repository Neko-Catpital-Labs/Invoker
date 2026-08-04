import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runInvokerCliSetup, runMachinesSetup } from '../invoker-cli-setup.js';

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

describe('runMachinesSetup', () => {
  it('writes the machine fields to stdin and parses one result per machine', async () => {
    const cliPath = makeCli(`
process.stdin.resume();
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2).join(' ');
  if (args !== 'setup machines --json') { process.exit(9); return; }
  const machines = JSON.parse(raw);
  const results = machines.map((machine, index) => ({
    index,
    id: machine.host.replace(/[^a-z0-9]+/gi, '-'),
    host: machine.host,
    reachable: true,
    detail: 'ssh probe succeeded',
    written: true,
  }));
  process.stdout.write(JSON.stringify(results));
  process.exit(0);
});
`);
    const deps = makeDeps(cliPath);

    const outcome = await runMachinesSetup([
      { host: 'box-a.example.com', user: 'deploy', sshKeyPath: '/keys/box-a', port: 22, maxConcurrentTasks: 2 },
      { host: 'box-b.example.com', user: 'deploy', sshKeyPath: '/keys/box-b' },
    ], deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.results).toEqual([
      { index: 0, id: 'box-a-example-com', host: 'box-a.example.com', reachable: true, detail: 'ssh probe succeeded', written: true },
      { index: 1, id: 'box-b-example-com', host: 'box-b.example.com', reachable: true, detail: 'ssh probe succeeded', written: true },
    ]);
  });

  it('returns an error result instead of throwing when the child process fails', async () => {
    const cliPath = makeCli(`
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stderr.write('boom: ssh binary missing');
  process.exit(3);
});
`);
    const deps = makeDeps(cliPath);

    const outcome = await runMachinesSetup([
      { host: 'box-c.example.com', user: 'deploy', sshKeyPath: '/keys/box-c' },
    ], deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.results).toEqual([]);
    expect(outcome.error).toContain('boom: ssh binary missing');
  });

  it('never writes machine field values to console output', async () => {
    const cliPath = makeCli(`
process.stdin.resume();
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const machines = JSON.parse(raw);
  const results = machines.map((machine, index) => ({ index, host: machine.host, reachable: true, detail: 'ok', written: true }));
  process.stdout.write(JSON.stringify(results));
  process.exit(0);
});
`);
    const deps = makeDeps(cliPath);
    const secretKeyPath = '/keys/super-secret-id-rsa';
    const secretProvisionCommand = 'echo secret-provision-token';

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runMachinesSetup([
        { host: 'box-d.example.com', user: 'deploy', sshKeyPath: secretKeyPath, provisionCommand: secretProvisionCommand },
      ], deps);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const loggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ');
    expect(loggedText).not.toContain(secretKeyPath);
    expect(loggedText).not.toContain(secretProvisionCommand);
  });
});
