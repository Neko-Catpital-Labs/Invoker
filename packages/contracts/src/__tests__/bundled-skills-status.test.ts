import { describe, expect, it } from 'vitest';
import type { BundledSkillsStatus, SystemDiagnostics } from '../ipc-channels.js';

describe('BundledSkillsStatus contract', () => {
  it('requires harness command and MCP config state arrays on diagnostics fixtures', () => {
    const bundledSkills = {
      available: true,
      promptRecommended: true,
      managedPrefix: 'invoker-',
      bundledSkillNames: ['plan-to-invoker'],
      targets: [
        { id: 'codex', name: 'Codex', path: '/tmp/.codex/skills', available: true, installed: true, upToDate: true, installedSkillNames: ['invoker-plan-to-invoker'] },
      ],
      commandTargets: [
        { id: 'omp', name: 'OMP', path: '/tmp/.omp/agent/commands', available: true, installed: true, upToDate: true, installedCommandNames: ['invoker-plan-to-invoker'] },
      ],
      mcpTargets: [
        { id: 'omp', name: 'OMP', path: '/tmp/.omp/agent/mcp.json', available: true, installed: true, upToDate: true, serverName: 'invoker' },
      ],
    } satisfies BundledSkillsStatus;

    const diagnostics = {
      platform: 'darwin',
      arch: 'arm64',
      appVersion: '0.0.5',
      isPackaged: true,
      tools: [],
      bundledSkills,
    } satisfies SystemDiagnostics;

    expect(diagnostics.bundledSkills.commandTargets[0]?.installedCommandNames).toEqual(['invoker-plan-to-invoker']);
    expect(diagnostics.bundledSkills.mcpTargets[0]?.serverName).toBe('invoker');
  });
});
