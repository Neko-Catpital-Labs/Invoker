import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRAFTER_MCP_PACKAGE_SPEC } from '@invoker/contracts';

import {
  formatCommandHelp,
  formatRootHelp,
  listHelpCommandGroups,
  listRootHelpCommands,
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
  'Workflow execution',
  'Workflow and task queries',
  'Workflow and task management',
  'Owner and workers',
  'Runtime controls',
  'Installation and diagnostics',
  'Setup and integrations',
] as const;

const EXPECTED_COMMAND_IDS = [
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
  'agent-login',
  'owner serve',
  'worker',
  'worker toggles',
  'run-worker',
  'spend-gate',
  'auto-approve-authors',
  'install',
  'uninstall',
  'doctor',
  'setup',
  'mcp',
] as const;

describe('cli help catalog', () => {
  it('lists every command under the intended groups', () => {
    const groups = listHelpCommandGroups();
    expect(groups.map((group) => group.title)).toEqual([...EXPECTED_GROUPS]);

    const byGroup = new Map(groups.map((group) => [group.title, group.commands.map((command) => command.id)]));
    expect(byGroup.get('Workflow execution')).toEqual(['run', 'wait']);
    expect(byGroup.get('Workflow and task queries')).toEqual([
      'query workflows',
      'query tasks',
      'query workflow',
      'query task',
      'query capacity',
    ]);
    expect(byGroup.get('Workflow and task management')).toEqual([
      'retry',
      'resume',
      'retry-task',
      'retry-tasks',
      'set',
      'delete',
      'delete-all',
      'agent-login',
    ]);
    expect(byGroup.get('Owner and workers')).toEqual([
      'owner serve',
      'worker',
      'worker toggles',
      'run-worker',
    ]);
    expect(byGroup.get('Runtime controls')).toEqual(['spend-gate', 'auto-approve-authors']);
    expect(byGroup.get('Installation and diagnostics')).toEqual(['install', 'uninstall', 'doctor']);
    expect(byGroup.get('Setup and integrations')).toEqual(['setup', 'mcp']);
  });

  it('keeps root help discoverable, grouped, and free of ANSI color', () => {
    const help = formatRootHelp();
    expect(help.startsWith('Invoker CLI\n')).toBe(true);
    expect(help).toContain('Usage:\n  invoker-cli <command> [options]');
    expect(help).toContain('Global options:');
    expect(help).toContain('Query options:');
    expect(help).toContain('Execution and mutation options:');
    expect(help).toContain('Installation and setup options:');
    expect(help).toContain('Planner setup options:');
    expect(help).toContain('Run \'invoker-cli <command> --help\' for command-specific options and details.');
    expect(help).not.toMatch(/\u001b\[|\x1b\[/);

    for (const group of EXPECTED_GROUPS) {
      expect(help).toContain(`  ${group}`);
    }
    for (const command of listRootHelpCommands()) {
      expect(help).toContain(command.usage);
      expect(EXPECTED_COMMAND_IDS).toContain(command.id);
    }
  });

  it('preserves set fields, force semantics, concurrency, spend-gate, and auto-approve notes', () => {
    const help = formatRootHelp();
    expect(help).toContain(`Fields: ${CLI_SET_FIELDS.join(', ')}.`);
    expect(help).toContain('Let `set` edit a running task; the owner cancels the launched attempt first.');
    expect(help).toContain('Maximum concurrent mutation requests for `retry-tasks`. Defaults to 8.');
    expect(help).toContain('While tripped, every Codex request fails');
    expect(help).toContain('Does not enable the auto-approve toggle.');
    expect(help).toContain('the owner snapshots the DB first.');
    expect(help).toContain(`Defaults to ${DEFAULT_DRAFTER_MCP_PACKAGE_SPEC}`);
    expect(help).toContain('Defaults to ~/.invoker/mcp.json');
  });

  it('formats command-specific help for supported commands', () => {
    expect(formatCommandHelp('query')).toContain('Usage: invoker-cli query <workflows|tasks|workflow <id>|task <id>|capacity>');
    expect(formatCommandHelp('query')).toContain('--workflow <id>');
    expect(formatCommandHelp('retry-tasks')).toContain('--parallel N');
    expect(formatCommandHelp('retry-tasks')).toContain('Defaults to 8.');
    expect(formatCommandHelp('set')).toContain('--force');
    expect(formatCommandHelp('setup')).toContain('--planner-url <url>');
    expect(formatCommandHelp('uninstall')).toContain('--keep-data');
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
      expect(output.stdout).toContain('Workflow execution');
      expect(output.stdout).toContain('run <plan.yaml>');
      expect(output.stdout).not.toMatch(/\u001b\[|\x1b\[/);
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
      { argv: ['auto-approve-authors', '--help'], needle: 'Does not enable the auto-approve toggle.' },
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
