import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadless, type HeadlessDeps } from '../headless.js';

function makeStatus() {
  return {
    available: true,
    promptRecommended: false,
    managedPrefix: 'invoker-',
    bundledSkillNames: ['plan-to-invoker', 'make-pr'],
    targets: [
      { id: 'codex', name: 'Codex', path: '/tmp/.codex/skills', available: true, installed: true, upToDate: true, installedSkillNames: ['invoker-plan-to-invoker'] },
    ],
    commandTargets: [
      { id: 'omp', name: 'OMP', path: '/tmp/.omp/agent/commands', available: true, installed: true, upToDate: true, installedCommandNames: ['invoker-plan-to-invoker'] },
    ],
    mcpTargets: [
      { id: 'omp', name: 'OMP', path: '/tmp/.omp/agent/mcp.json', available: true, installed: true, upToDate: true, serverName: 'invoker' },
    ],
  };
}


describe('headless install-skills', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints skill, command, and MCP helper install targets', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const installBundledSkills = vi.fn(() => makeStatus());

    await runHeadless(['install-skills', 'reinstall'], {
      installBundledSkills,
    } as unknown as HeadlessDeps);

    expect(installBundledSkills).toHaveBeenCalledWith('reinstall');
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('Installed 2 bundled AI helpers with prefix "invoker-".');
    expect(output).toContain('Skill target (Codex): /tmp/.codex/skills');
    expect(output).toContain('Command target (OMP): /tmp/.omp/agent/commands');
    expect(output).toContain('MCP target (OMP): /tmp/.omp/agent/mcp.json');
    expect(output).toContain('- invoker-plan-to-invoker');
    expect(output).toContain('- invoker-make-pr');
  });

  it('throws a clear error when helper installation is unavailable', async () => {
    await expect(runHeadless(['install-skills'], {} as HeadlessDeps)).rejects.toThrow(
      'Bundled AI helper installation is not available in this runtime.',
    );
  });

  it('documents helper installation and OMP agent selection in help output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['--help'], {} as HeadlessDeps);

    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('install-skills [install|update|reinstall]          Install bundled Invoker AI helpers');
    expect(output).toContain('set agent <taskId> <harness>                       Change AI harness (claude|codex|omp)');
    expect(output).toContain('set model <taskId> <model>                         Change AI model and re-run; empty clears override');
  });
});
