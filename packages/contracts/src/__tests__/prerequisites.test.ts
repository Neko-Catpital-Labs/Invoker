import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRAFTER_MCP_PACKAGE_SPEC,
  DEFAULT_TOOL_REQUIREMENTS,
  EXTERNAL_DEPENDENCIES,
} from '../index.js';


import {
  assembleReadinessChecks,
  buildReport,
  checkConfig,
  checkConfigContents,
  checkDefaultPresetTool,
  checkPlanningToolsPresent,
  checkTool,
  formatReport,
  type PlanningPresetSpec,
} from '../prerequisites.js';

const installed = (...tools: string[]) => (cmd: string) => tools.includes(cmd);
const presets: Record<string, PlanningPresetSpec> = {
  'cursor+claude': { tool: 'cursor', model: 'claude' },
  omp: { tool: 'omp' },
  codex: { tool: 'codex' },
};

describe('external dependency manifest', () => {
  it('derives doctor tool checks from the shared dependency list', () => {
    expect(DEFAULT_TOOL_REQUIREMENTS.map((req) => req.id)).toEqual([
      'git',
      'pnpm',
      'gh',
      'docker',
      'ssh',
      'codex',
      'claude',
      'cursor',
      'omp',
    ]);
    for (const req of DEFAULT_TOOL_REQUIREMENTS) {
      const dependency = EXTERNAL_DEPENDENCIES[req.id as keyof typeof EXTERNAL_DEPENDENCIES];
      expect(dependency).toMatchObject({
        id: req.id,
        name: req.name,
        command: req.command,
        requiredFor: req.requiredFor,
      });
    }
    expect(EXTERNAL_DEPENDENCIES.node.versionRange).toBe('26.x');
    expect(EXTERNAL_DEPENDENCIES.pnpm.version).toBe('10.31.0');
  });

  it('pins the Drafter MCP as an independently versioned package', () => {
    expect(EXTERNAL_DEPENDENCIES.drafterMcp).toMatchObject({
      packageName: 'drafter-mcp',
      version: '0.1.0',
      commandName: 'drafter-mcp',
      runner: 'uvx',
      configEnvVar: 'INVOKER_MCP_CONFIG_PATH',
    });
    expect(DEFAULT_DRAFTER_MCP_PACKAGE_SPEC).toBe('drafter-mcp==0.1.0');
  });
});

describe('checkTool', () => {
  it('passes when the command is installed', () => {
    expect(checkTool({ id: 'git', name: 'Git', command: 'git', requiredFor: 'checkout', required: true }, installed('git')).status).toBe('ok');
  });

  it('errors for a missing required tool and warns for a missing optional one', () => {
    const req = { id: 'docker', name: 'Docker', command: 'docker', requiredFor: 'containers', installHint: 'brew install docker' };
    expect(checkTool({ ...req, required: true }, installed()).status).toBe('error');
    const optional = checkTool(req, installed());
    expect(optional.status).toBe('warn');
    expect(optional.remediation).toBe('brew install docker');
  });
});

describe('checkConfig', () => {
  it('is ok when no config file exists', () => {
    expect(checkConfig({ path: '/x/config.json', exists: false }).status).toBe('ok');
  });

  it('is ok when the file parses', () => {
    expect(checkConfig({ path: '/x/config.json', exists: true }).status).toBe('ok');
  });

  it('errors with the parse message when the JSON is invalid', () => {
    const c = checkConfig({ path: '/x/config.json', exists: true, error: 'Unexpected token }' });
    expect(c.status).toBe('error');
    expect(c.remediation).toContain('Unexpected token }');
  });
});

describe('checkDefaultPresetTool', () => {
  it('passes when the default preset tool is installed', () => {
    expect(checkDefaultPresetTool(presets, 'omp', installed('omp')).status).toBe('ok');
  });

  it('errors when the default preset tool is not on PATH', () => {
    const c = checkDefaultPresetTool(presets, 'cursor+claude', installed('omp'));
    expect(c.status).toBe('error');
    expect(c.detail).toBe('Default preset "cursor+claude" needs "cursor", which is not on Invoker\'s PATH');
    expect(c.remediation).toBe("Make cursor available on Invoker's PATH (restart Invoker if it already works in a terminal), or set defaultSlackHarnessPreset to a preset whose tool is available");
    expect(c.remediation).not.toMatch(/^Install /);
  });

  it('errors and lists valid keys when the default preset is undefined', () => {
    const c = checkDefaultPresetTool(presets, 'mystery', installed('omp'));
    expect(c.status).toBe('error');
    expect(c.remediation).toContain('omp');
  });
});

describe('checkPlanningToolsPresent', () => {
  it('passes when any preset tool is installed', () => {
    const c = checkPlanningToolsPresent(presets, installed('codex'));
    expect(c.status).toBe('ok');
    expect(c.detail).toBe("Available on Invoker's PATH: codex");
  });

  it("reports PATH availability without claiming configured planning tools are uninstalled", () => {
    const c = checkPlanningToolsPresent(presets, installed('git'));
    expect(c.status).toBe('error');
    expect(c.detail).toBe("Planning unavailable: none of the configured planner commands are on Invoker's PATH (cursor, omp, codex)");
    expect(c.remediation).toBe("Make one of these commands available on Invoker's PATH: cursor, omp, codex. If it already works in a terminal, restart Invoker to refresh its shell environment; otherwise install it or configure another planning preset.");
    expect(c.detail).not.toContain('installed');
    expect(c.remediation).not.toMatch(/^Install /);
  });
});

describe('invoker-setup planning availability guidance', () => {
  it('distinguishes PATH visibility from installation state', () => {
    const skill = readFileSync(new URL('../../../../skills/invoker-setup/SKILL.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    expect(skill).toContain("not available on Invoker's own `PATH`");
    expect(skill).toContain('Do not report that command as uninstalled based on this probe alone');
    expect(skill).toContain('restart Invoker to refresh its shell environment');
  });
});

describe('buildReport / formatReport', () => {
  it('marks the report not-ok when any check errors', () => {
    const report = buildReport([
      checkTool({ id: 'git', name: 'Git', command: 'git', requiredFor: 'checkout', required: true }, installed('git')),
      checkPlanningToolsPresent(presets, installed()),
    ]);
    expect(report.ok).toBe(false);
  });

  it('stays ok when only warnings are present', () => {
    const report = buildReport([
      checkTool({ id: 'docker', name: 'Docker', command: 'docker', requiredFor: 'containers' }, installed()),
    ]);
    expect(report.ok).toBe(true);
  });

  it('emits machine-readable JSON and shows remediation in text mode', () => {
    const report = buildReport([checkPlanningToolsPresent(presets, installed())]);
    expect(JSON.parse(formatReport(report, { json: true }))).toEqual(report);
    const text = formatReport(report);
    expect(text).toContain("-> Make one of these commands available on Invoker's PATH");
  });
});

describe('checkConfigContents', () => {
  it('passes a config with consistent targets, pools, and routing', () => {
    const check = checkConfigContents({
      remoteTargets: { box: { host: 'h', user: 'u', sshKeyPath: '/k' } },
      executionPools: { fast: { members: [{ type: 'ssh', id: 'box' }] } },
      defaultPoolId: 'fast',
      infraRepair: { enabled: true },
    });
    expect(check.status).toBe('ok');
  });

  it('fails when a pool references a remote target that is not configured', () => {
    const check = checkConfigContents({
      executionPools: { fast: { members: [{ type: 'ssh', id: 'ghost' }] } },
    });
    expect(check.status).toBe('error');
    expect(check.detail).toContain('ghost');
  });

  it('fails a defaultPoolId that points nowhere even when no pools exist', () => {
    expect(checkConfigContents({ defaultPoolId: 'fast' }).status).toBe('error');
  });

  it('warns without failing when one member is shared across pools', () => {
    const check = checkConfigContents({
      worktreeTargets: { local: { repoPath: '/repo' } },
      executionPools: {
        fast: { members: [{ type: 'worktree', id: 'local' }] },
        slow: { members: [{ type: 'worktree', id: 'local' }] },
      },
    });
    expect(check.status).toBe('warn');
  });
});

describe('assembleReadinessChecks config contents wiring', () => {
  const noTools = { tools: [], isInstalled: () => true };

  it('omits the semantic check when no config contents are supplied', () => {
    const ids = assembleReadinessChecks(noTools).map((check) => check.id);
    expect(ids).not.toContain('config-contents');
  });

  it('includes the semantic check when config contents are supplied', () => {
    const checks = assembleReadinessChecks({ ...noTools, configContents: { defaultPoolId: 'missing' } });
    expect(checks.find((check) => check.id === 'config-contents')?.status).toBe('error');
  });
});
