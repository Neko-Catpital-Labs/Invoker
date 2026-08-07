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
  const secretKeyPath = '/home/user/.ssh/super-secret-machine-key';

  it('writes machine fields to stdin and returns one result per machine', async () => {
    const cliPath = makeCli(`
const args = process.argv.slice(2).join(' ');
if (args !== 'setup machines --json') process.exit(9);
let data = '';
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  const machines = JSON.parse(data);
  const results = machines.map((m) => ({
    id: m.id ?? m.host,
    host: m.host,
    reachable: true,
    written: true,
    detail: 'ssh probe succeeded',
  }));
  process.stdout.write(JSON.stringify(results));
});
`);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const results = await runMachinesSetup([
      { host: 'box-a.example.com', user: 'deploy', sshKeyPath: secretKeyPath },
      { id: 'box-b', host: 'box-b.example.com', user: 'deploy', sshKeyPath: secretKeyPath, port: 2222 },
    ], { cliPath });

    logSpy.mockRestore();
    errorSpy.mockRestore();

    expect(results).toEqual([
      { id: 'box-a.example.com', host: 'box-a.example.com', reachable: true, written: true, detail: 'ssh probe succeeded' },
      { id: 'box-b', host: 'box-b.example.com', reachable: true, written: true, detail: 'ssh probe succeeded' },
    ]);

    for (const call of [...logSpy.mock.calls, ...errorSpy.mock.calls]) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(secretKeyPath);
      }
    }
  });

  it('returns an error result per machine when the child process fails', async () => {
    const cliPath = makeCli(`
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stderr.write('connectivity checker unavailable');
  process.exit(3);
});
`);

    const results = await runMachinesSetup([
      { host: 'box-a.example.com', user: 'deploy', sshKeyPath: secretKeyPath },
    ], { cliPath });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'box-a.example.com',
      host: 'box-a.example.com',
      reachable: false,
      written: false,
    });
    expect(results[0].error?.message).toContain('connectivity checker unavailable');
  });

  it('returns an error result when the child writes unparsable output', async () => {
    const cliPath = makeCli(`
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stdout.write('not json');
});
`);

    const results = await runMachinesSetup([
      { host: 'box-a.example.com', user: 'deploy', sshKeyPath: secretKeyPath },
    ], { cliPath });

    expect(results).toHaveLength(1);
    expect(results[0].reachable).toBe(false);
    expect(results[0].written).toBe(false);
    expect(results[0].error?.message).toContain('Unable to parse invoker-cli output');
  });
});
