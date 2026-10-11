import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRAFTER_MCP_PACKAGE_SPEC } from '@invoker/contracts';

import {
  formatCommandHelp,
  formatRootHelp,
  listHelpCommandGroups,
  listRootHelpCommands,
  shouldUseHelpColor,
} from '../cli-help.js';
import { CLI_SET_FIELDS, main } from '../index.js';

function captureProcessOutput() {
  let stdout = '';
  let stderr = '';
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout += chunk.toString();
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr += chunk.toString();
    return true;
  });
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

const EXPECTED_GROUPS = [
  'Getting started',
  'Run workflows',
  'Look up status',
  'Manage workflows & tasks',
  'Owner & workers',
  'Advanced',
] as const;

const EXPECTED_COMMAND_IDS = [
  'install',
  'doctor',
  'setup',
  'mcp',
  'run',
  'wait',
  'query workflows',
  'query tasks',
  'query workflow',
  'query task',
  'query capacity',
  'retry',
  'resume',
  'retry-task',
  'retry-tasks',
  'set',
  'delete',
  'delete-all',
  'owner serve',
  'worker',
  'worker toggles',
  'run-worker',
  'spend-gate',
  'auto-approve-authors',
  'agent-login',
  'uninstall',
] as const;

describe('cli help catalog', () => {
  it('lists every command under priority-ordered groups', () => {
    const groups = listHelpCommandGroups();
    expect(groups.map((group) => group.title)).toEqual([...EXPECTED_GROUPS]);

    const byGroup = new Map(groups.map((group) => [group.title, group.commands.map((command) => command.id)]));
    expect(byGroup.get('Getting started')).toEqual(['install', 'doctor', 'setup', 'mcp']);
    expect(byGroup.get('Run workflows')).toEqual(['run', 'wait']);
    expect(byGroup.get('Look up status')).toEqual([
      'query workflows',
      'query tasks',
      'query workflow',
      'query task',
      'query capacity',
    ]);
    expect(byGroup.get('Manage workflows & tasks')).toEqual([
      'retry',
      'resume',
      'retry-task',
      'retry-tasks',
      'set',
      'delete',
      'delete-all',
    ]);
    expect(byGroup.get('Owner & workers')).toEqual([
      'owner serve',
      'worker',
      'worker toggles',
      'run-worker',
    ]);
    expect(byGroup.get('Advanced')).toEqual([
      'spend-gate',
      'auto-approve-authors',
      'agent-login',
      'uninstall',
    ]);
  });

  it('keeps root help scannable and plain without color', () => {
    const help = formatRootHelp({ color: false });
    expect(help.startsWith('Invoker CLI\n')).toBe(true);
    expect(help).toContain('Usage\n  invoker-cli <command> [options]');
    expect(help).toContain('Common options');
    expect(help).toContain('More detail: invoker-cli <command> --help');
    expect(help).not.toMatch(/\u001b\[|\x1b\[/);

    for (const group of EXPECTED_GROUPS) {
      expect(help).toContain(`  ${group}`);
    }
    for (const command of listRootHelpCommands()) {
      expect(help).toContain(command.usage);
      expect(EXPECTED_COMMAND_IDS).toContain(command.id);
    }
  });

  it('uses ANSI color when requested', () => {
    const help = formatRootHelp({ color: true });
    expect(help).toMatch(/\u001b\[/);
    expect(help).toContain('Invoker CLI');
    expect(help).toContain('Getting started');
  });

  it('honors NO_COLOR for auto color detection', () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      expect(shouldUseHelpColor()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });

  it('preserves important behavioral notes in command help', () => {
    const root = formatRootHelp({ color: false });
    expect(root).toContain(`Change a task field (${CLI_SET_FIELDS.join(', ')}).`);
    expect(root).toContain('Check or clear the Codex spend shutoff.');
    expect(root).toContain('does not turn the toggle on');
    expect(root).toContain('owner snapshots the DB first');

    const setHelp = formatCommandHelp('set', { color: false });
    expect(setHelp).toContain('--force');
    expect(setHelp).toContain('Running tasks need --force');

    const retryHelp = formatCommandHelp('retry-tasks', { color: false });
    expect(retryHelp).toContain('default 8');

    const setupHelp = formatCommandHelp('setup', { color: false });
    expect(setupHelp).toContain(`default ${DEFAULT_DRAFTER_MCP_PACKAGE_SPEC}`);
    expect(setupHelp).toContain('~/.invoker/mcp.json');
  });

  it('formats command-specific help for supported commands', () => {
    expect(formatCommandHelp('query', { color: false })).toContain('Usage: invoker-cli query <workflows|tasks|workflow <id>|task <id>|capacity>');
    expect(formatCommandHelp('query', { color: false })).toContain('--workflow <id>');
    expect(formatCommandHelp('retry-tasks', { color: false })).toContain('--parallel N');
    expect(formatCommandHelp('set', { color: false })).toContain('--force');
    expect(formatCommandHelp('setup', { color: false })).toContain('--planner-url <url>');
    expect(formatCommandHelp('uninstall', { color: false })).toContain('--keep-data');
  });
});

describe('invoker-cli --help integration', () => {
  it('prints grouped root help on --help and -h', async () => {
    for (const flag of ['--help', '-h'] as const) {
      const output = captureProcessOutput();
      const code = await main([flag]);
      output.restore();
      expect(code).toBe(0);
      expect(output.stderr).toBe('');
      expect(output.stdout).toContain('Invoker CLI');
      expect(output.stdout).toContain('Getting started');
      expect(output.stdout).toContain('Run workflows');
      expect(output.stdout).toContain('run <plan.yaml>');
    }
  });

  it('prints command-specific help on stdout with exit 0', async () => {
    const cases: Array<{ argv: string[]; needle: string }> = [
      { argv: ['query', '--help'], needle: 'Usage: invoker-cli query' },
      { argv: ['query', 'tasks', '--help'], needle: 'query tasks' },
      { argv: ['retry-tasks', '--help'], needle: 'retry-tasks --status <status>' },
      { argv: ['set', '--help'], needle: 'Usage: invoker-cli set' },
      { argv: ['wait', '--help'], needle: 'Usage: invoker-cli wait' },
      { argv: ['setup', 'planner', '--help'], needle: 'Usage: invoker-cli setup' },
      { argv: ['spend-gate', '--help'], needle: 'spend-gate [status|reset]' },
      { argv: ['auto-approve-authors', '--help'], needle: 'does not turn the toggle on' },
      { argv: ['doctor', '--help'], needle: 'doctor [--fix] [--json]' },
    ];

    for (const testCase of cases) {
      const output = captureProcessOutput();
      const code = await main(testCase.argv);
      output.restore();
      expect(code).toBe(0);
      expect(output.stderr).toBe('');
      expect(output.stdout).toContain(testCase.needle);
    }
  });

  it('keeps uninstall --help coverage and exit-code documentation', async () => {
    const output = captureProcessOutput();
    const code = await main(['uninstall', '--help']);
    output.restore();
    expect(code).toBe(0);
    expect(output.stdout).toContain('Exit codes:');
    expect(output.stdout).toContain('--keep-data');
    expect(output.stdout).toContain('Coverage:');
  });

  it('--version still prints only the version', async () => {
    const output = captureProcessOutput();
    const code = await main(['--version']);
    output.restore();
    expect(code).toBe(0);
    expect(output.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(output.stderr).toBe('');
  });
});
