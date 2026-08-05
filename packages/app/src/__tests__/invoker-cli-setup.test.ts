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
  const SECRET_SSH_KEY_PATH = '/home/example/.ssh/super-secret-key';

  const readMachinesFromStdin = `
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const machines = JSON.parse(Buffer.concat(chunks).toString());
`;

  it('spawns the CLI machines mode over stdin and returns one result per machine', async () => {
    const cliPath = makeCli(`${readMachinesFromStdin}
  const results = machines.map((m) => ({
    id: m.host.replace(/[^a-z0-9]/gi, '-'),
    host: m.host,
    reachable: true,
    detail: 'ssh probe ok',
    written: true,
  }));
  process.stdout.write(JSON.stringify(results));
});
`);

    const machines = [
      { host: 'box-a.example.com', user: 'deploy', sshKeyPath: SECRET_SSH_KEY_PATH, port: 2222, maxConcurrentTasks: 2, provisionCommand: 'echo hi' },
      { host: 'box-b.example.com', user: 'deploy', sshKeyPath: SECRET_SSH_KEY_PATH },
    ];

    const result = await runMachinesSetup(machines, { cliPath });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(2);
    expect(result.results.map((r) => r.host)).toEqual(['box-a.example.com', 'box-b.example.com']);
    expect(result.results.every((r) => r.written)).toBe(true);
  });

  it('returns an error result instead of throwing when the child process fails', async () => {
    const cliPath = makeCli(`${readMachinesFromStdin}
  process.stderr.write('connectivity check crashed');
  process.exit(9);
});
`);

    const machines = [{ host: 'box-a.example.com', user: 'deploy', sshKeyPath: SECRET_SSH_KEY_PATH }];

    await expect(runMachinesSetup(machines, { cliPath })).resolves.toMatchObject({
      ok: false,
      results: [],
    });
    const result = await runMachinesSetup(machines, { cliPath });
    expect(result.error).toContain('9');
  });

  it('never writes machine field values to console output', async () => {
    const cliPath = makeCli(`${readMachinesFromStdin}
  const results = machines.map((m) => ({ id: m.host, host: m.host, reachable: true, detail: 'ok', written: true }));
  process.stdout.write(JSON.stringify(results));
});
`);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const machines = [{ host: 'box-a.example.com', user: 'deploy', sshKeyPath: SECRET_SSH_KEY_PATH }];
      await runMachinesSetup(machines, { cliPath });

      const allLoggedArgs = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat();
      for (const arg of allLoggedArgs) {
        expect(String(arg)).not.toContain(SECRET_SSH_KEY_PATH);
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
