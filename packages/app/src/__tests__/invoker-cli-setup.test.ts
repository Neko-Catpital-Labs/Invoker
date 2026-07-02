import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runInvokerCliSetup } from '../invoker-cli-setup.js';

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
