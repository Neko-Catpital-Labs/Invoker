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
  it('writes the machine field set to stdin and returns one result per machine', async () => {
    const cliPath = makeCli(`
const args = process.argv.slice(2).join(' ');
if (args !== 'setup machines --json') process.exit(9);
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const machines = JSON.parse(input);
  const results = machines.map((m) => ({ name: m.name, reachable: true, written: true, message: 'Wrote machine "' + m.name + '"' }));
  process.stdout.write(JSON.stringify(results));
});
`);

    const results = await runMachinesSetup([
      { name: 'box1', host: 'example.com', user: 'deploy', sshKeyPath: '/home/deploy/.ssh/id_ed25519' },
      { name: 'box2', host: 'example2.com', user: 'deploy', sshKeyPath: '/home/deploy/.ssh/id_ed25519' },
    ], { cliPath });

    expect(results).toEqual([
      { name: 'box1', reachable: true, written: true, message: 'Wrote machine "box1"' },
      { name: 'box2', reachable: true, written: true, message: 'Wrote machine "box2"' },
    ]);
  });

  it('returns an error result for every machine when the child process fails', async () => {
    const cliPath = makeCli(`
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stderr.write('boom');
  process.exit(3);
});
`);

    const results = await runMachinesSetup([
      { name: 'box1', host: 'example.com', user: 'deploy', sshKeyPath: '/home/deploy/.ssh/id_ed25519' },
      { name: 'box2', host: 'example2.com', user: 'deploy', sshKeyPath: '/home/deploy/.ssh/id_ed25519' },
    ], { cliPath });

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.written).toBe(false);
      expect(result.error?.code).toBeTruthy();
    }
  });

  it.each([
    ['empty array', '[]'],
    ['malformed result', '[{}]'],
  ])('returns an error result for every machine when the child process returns %s', async (_label, output) => {
    const cliPath = makeCli(`
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(output)});
});
`);

    const results = await runMachinesSetup([
      { name: 'box1', host: 'example.com', user: 'deploy', sshKeyPath: '/home/deploy/.ssh/id_ed25519' },
    ], { cliPath });

    expect(results).toEqual([
      {
        written: false,
        message: 'invoker-cli returned invalid machine setup output',
        error: {
          code: 'invoker-cli-failed',
          message: 'invoker-cli returned invalid machine setup output',
        },
      },
    ]);
  });

  it('never writes machine field values to console output', async () => {
    const secretKeyPath = '/home/deploy/.ssh/super-secret-token-abc123';
    const cliPath = makeCli(`
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const machines = JSON.parse(input);
  const results = machines.map((m) => ({ name: m.name, reachable: true, written: true, message: 'ok' }));
  process.stdout.write(JSON.stringify(results));
});
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await runMachinesSetup([
        { name: 'box1', host: 'example.com', user: 'deploy', sshKeyPath: secretKeyPath },
      ], { cliPath });

      const captured = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((value) => String(value))
        .join(' ');
      expect(captured).not.toContain(secretKeyPath);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
