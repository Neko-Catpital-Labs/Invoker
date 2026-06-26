import { describe, expect, it } from 'vitest';

import {
  buildReport,
  checkConfig,
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
    expect(c.detail).toContain('cursor');
    expect(c.remediation).toContain('defaultSlackHarnessPreset');
  });

  it('errors and lists valid keys when the default preset is undefined', () => {
    const c = checkDefaultPresetTool(presets, 'mystery', installed('omp'));
    expect(c.status).toBe('error');
    expect(c.remediation).toContain('omp');
  });
});

describe('checkPlanningToolsPresent', () => {
  it('passes when any preset tool is installed', () => {
    expect(checkPlanningToolsPresent(presets, installed('codex')).status).toBe('ok');
  });

  it('errors when no planning tool is installed', () => {
    const c = checkPlanningToolsPresent(presets, installed('git'));
    expect(c.status).toBe('error');
    expect(c.remediation).toContain('cursor');
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
    expect(formatReport(report)).toContain('-> Install at least one');
  });
});
