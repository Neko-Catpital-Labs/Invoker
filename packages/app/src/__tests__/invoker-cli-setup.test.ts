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
  const secretKeyPath = '/very/secret/id_ed25519-test-only';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes machines to stdin and returns one result per input machine', async () => {
    const cliPath = makeCli(`
const args = process.argv.slice(2).join(' ');
if (args !== 'setup machines --json') process.exit(9);
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const machines = JSON.parse(raw);
  const results = machines.map((m) => ({ id: m.host, host: m.host, reachable: true, detail: 'ssh ok', written: true }));
  process.stdout.write(JSON.stringify(results));
});
`);

    const result = await runMachinesSetup(cliPath, [
      { host: 'one.example.com', user: 'deploy', sshKeyPath: secretKeyPath },
      { host: 'two.example.com', user: 'deploy', sshKeyPath: secretKeyPath },
    ]);

    expect(result).toEqual({
      ok: true,
      results: [
        { id: 'one.example.com', host: 'one.example.com', reachable: true, detail: 'ssh ok', written: true },
        { id: 'two.example.com', host: 'two.example.com', reachable: true, detail: 'ssh ok', written: true },
      ],
    });
  });

  it('returns an error result instead of throwing when the child process fails', async () => {
    const cliPath = makeCli(`
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stderr.write('connection refused');
  process.exit(3);
});
`);

    const result = await runMachinesSetup(cliPath, [
      { host: 'down.example.com', user: 'deploy', sshKeyPath: secretKeyPath },
    ]);

    expect(result.ok).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('never writes machine field values to console output', async () => {
    const cliPath = makeCli(`
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const machines = JSON.parse(raw);
  const results = machines.map((m) => ({ id: m.host, host: m.host, reachable: true, detail: 'ssh ok', written: true }));
  process.stdout.write(JSON.stringify(results));
});
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runMachinesSetup(cliPath, [
      { host: 'three.example.com', user: 'deploy', sshKeyPath: secretKeyPath },
    ]);

    const failingCliPath = makeCli(`
process.stdin.on('data', () => {});
process.stdin.on('end', () => { process.stderr.write('boom'); process.exit(1); });
`);
    await runMachinesSetup(failingCliPath, [
      { host: 'four.example.com', user: 'deploy', sshKeyPath: secretKeyPath },
    ]);

    const allLoggedArgs = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat();
    for (const arg of allLoggedArgs) {
      expect(String(arg)).not.toContain(secretKeyPath);
    }
  });
});
