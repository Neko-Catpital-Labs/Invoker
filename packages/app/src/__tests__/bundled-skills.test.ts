import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { installBundledSkills, resolveBundledSkillsStatus } from '../bundled-skills.js';

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeSkill(sourceRoot: string, name: string): void {
  const skillDir = join(sourceRoot, 'skills', name);
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `# ${name}\n`);
  writeFileSync(join(skillDir, 'scripts', 'check.sh'), '#!/usr/bin/env bash\necho ok\n');
}

function writePlanToInvokerCommands(sourceRoot: string): void {
  const commandDir = join(sourceRoot, 'skills', 'plan-to-invoker', 'commands');
  mkdirSync(commandDir, { recursive: true });
  writeFileSync(join(commandDir, 'invoker-plan-to-invoker.md'), 'Submit with invoker_submit_plan\n');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bundled-skills', () => {
  it('reports promptRecommended for packaged apps before skills are installed', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-bundled-fakehome-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      writePlanToInvokerCommands(resourcesRoot);
      writeSkill(resourcesRoot, 'make-pr');

      const status = resolveBundledSkillsStatus({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
      });

      expect(status.commandTargets).toHaveLength(4);
      expect(status.commandTargets.every((target) => !target.installed)).toBe(true);
      expect(status.commandTargets.every((target) => !target.upToDate)).toBe(true);
      expect(status.mcpTargets).toHaveLength(1);
      expect(status.mcpTargets[0]?.installed).toBe(false);
      expect(status.mcpTargets[0]?.upToDate).toBe(false);

      expect(status.available).toBe(true);
      expect(status.promptRecommended).toBe(true);
      expect(status.bundledSkillNames).toEqual(['make-pr', 'plan-to-invoker']);
      expect(status.targets[0]?.installed).toBe(false);
      expect(status.targets[0]?.missingSkillNames).toEqual(['invoker-make-pr', 'invoker-plan-to-invoker']);
      expect(status.targets[0]?.staleReason).toBe('not-installed');
      expect(status.targets[0]?.diagnostic).toContain('prefix "invoker-"');
      expect(status.targets[0]?.diagnostic).toContain('invoker-plan-to-invoker');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

    }
  });

  it('installs prefixed skill copies into the Codex skill directory and marks them up to date', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const codexHome = makeTempRoot('invoker-codex-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = codexHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      writeSkill(resourcesRoot, 'make-pr');
      writePlanToInvokerCommands(resourcesRoot);

      const installed = installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
      });

      const expectedTargets = [
        join(codexHome, '.codex', 'skills'),
        join(codexHome, '.claude', 'skills'),
        join(codexHome, '.cursor', 'skills-cursor'),
      ];

      for (const targetRoot of expectedTargets) {
        expect(existsSync(join(targetRoot, 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(true);
        expect(existsSync(join(targetRoot, 'invoker-make-pr', 'scripts', 'check.sh'))).toBe(true);
        expect(readFileSync(join(targetRoot, 'invoker-plan-to-invoker', 'SKILL.md'), 'utf-8')).toContain('plan-to-invoker');
      }
      const expectedCommandTargets = [
        join(codexHome, '.codex', 'commands'),
        join(codexHome, '.claude', 'commands'),
        join(codexHome, '.cursor', 'commands'),
        join(codexHome, '.omp', 'agent', 'commands'),
      ];

      for (const targetRoot of expectedCommandTargets) {
        const installedCommand = join(targetRoot, 'invoker-plan-to-invoker.md');
        expect(existsSync(installedCommand)).toBe(true);
        expect(lstatSync(installedCommand).isSymbolicLink()).toBe(false);
        expect(readFileSync(installedCommand, 'utf-8')).toBe('Submit with invoker_submit_plan\n');
      }

      const mcpConfig = JSON.parse(readFileSync(join(codexHome, '.omp', 'agent', 'mcp.json'), 'utf-8'));
      expect(mcpConfig.$schema).toBe('https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json');
      expect(mcpConfig.mcpServers.invoker).toEqual({ type: 'stdio', command: 'invoker-cli', args: ['mcp'] });

      expect(installed.targets).toHaveLength(3);
      expect(installed.commandTargets).toHaveLength(4);
      expect(installed.mcpTargets).toHaveLength(1);
      expect(installed.targets.every((target) => target.installed)).toBe(true);
      expect(installed.targets.every((target) => target.upToDate)).toBe(true);
      expect(installed.commandTargets.every((target) => target.installed)).toBe(true);
      expect(installed.commandTargets.every((target) => target.upToDate)).toBe(true);
      expect(installed.mcpTargets.every((target) => target.installed)).toBe(true);
      expect(installed.mcpTargets.every((target) => target.upToDate)).toBe(true);
      expect(installed.promptRecommended).toBe(false);

      const status = resolveBundledSkillsStatus({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
      });
      expect(status.targets.every((target) => target.upToDate)).toBe(true);
      expect(status.commandTargets.every((target) => target.upToDate)).toBe(true);
      expect(status.mcpTargets.every((target) => target.upToDate)).toBe(true);
      expect(status.promptRecommended).toBe(false);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('preserves existing OMP MCP servers while adding Invoker', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-omp-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      writePlanToInvokerCommands(resourcesRoot);
      const mcpPath = join(fakeHome, '.omp', 'agent', 'mcp.json');
      mkdirSync(join(fakeHome, '.omp', 'agent'), { recursive: true });
      writeFileSync(mcpPath, JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['server'] } } }, null, 2));

      installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
      });

      const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
      expect(config.mcpServers.filesystem).toEqual({ command: 'npx', args: ['server'] });
      expect(config.mcpServers.invoker).toEqual({ type: 'stdio', command: 'invoker-cli', args: ['mcp'] });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('rejects invalid OMP MCP JSON without rewriting it', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-omp-invalid-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      writePlanToInvokerCommands(resourcesRoot);
      const mcpPath = join(fakeHome, '.omp', 'agent', 'mcp.json');
      mkdirSync(join(fakeHome, '.omp', 'agent'), { recursive: true });
      writeFileSync(mcpPath, '[]');

      expect(() => installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
      })).toThrow(`Invalid OMP MCP config at ${mcpPath}: expected a JSON object`);
      expect(readFileSync(mcpPath, 'utf-8')).toBe('[]');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('rejects malformed OMP MCP JSON without rewriting it', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-omp-malformed-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      writePlanToInvokerCommands(resourcesRoot);
      const mcpPath = join(fakeHome, '.omp', 'agent', 'mcp.json');
      mkdirSync(join(fakeHome, '.omp', 'agent'), { recursive: true });
      writeFileSync(mcpPath, '{"mcpServers":');

      expect(() => installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
      })).toThrow(`Invalid OMP MCP config at ${mcpPath}: expected a JSON object`);
      expect(readFileSync(mcpPath, 'utf-8')).toBe('{"mcpServers":');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('reports stale installed skills when the bundled source hash changes', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const codexHome = makeTempRoot('invoker-codex-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = codexHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
      });

      writeFileSync(join(resourcesRoot, 'skills', 'plan-to-invoker', 'SKILL.md'), '# plan-to-invoker\n\nUpdated bundled content.\n');

      const status = resolveBundledSkillsStatus({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
      });

      expect(status.targets.every((target) => target.installed)).toBe(true);
      expect(status.targets.every((target) => !target.upToDate)).toBe(true);
      expect(status.targets[0]?.staleReason).toBe('bundle-updated');
      expect(status.targets[0]?.diagnostic).toContain('bundled source changed');
      expect(status.targets[0]?.diagnostic).toContain('prefix "invoker-"');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
