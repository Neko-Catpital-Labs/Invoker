import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { installBundledSkills, resolveBundledSkillsStatus } from '../bundled-skills.js';

const tempRoots: string[] = [];

/** Deterministic stand-ins for `commandExists` — never probe the real machine in tests. */
const allHarnessesInstalled = () => true;
const onlyOmpInstalled = (command: string) => command === 'omp';

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeSkill(sourceRoot: string, name: string): void {
  const skillDir = join(sourceRoot, 'skills', name);
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill\n---\n\n# ${name}\n`);
  writeFileSync(join(skillDir, 'scripts', 'check.sh'), '#!/usr/bin/env bash\necho ok\n');
}

function writePlanToInvokerCommands(sourceRoot: string): void {
  const commandDir = join(sourceRoot, 'skills', 'plan-to-invoker', 'commands');
  mkdirSync(commandDir, { recursive: true });
  writeFileSync(join(commandDir, 'invoker-plan-to-invoker.md'), 'Submit with invoker_submit_plan\n');
  writeFileSync(join(commandDir, 'invoker-loop-generator.md'), 'Read and follow skill://loop-generator/SKILL.md\n');
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
        isInstalled: allHarnessesInstalled,
      });

      expect(status.commandTargets).toHaveLength(4);
      expect(status.commandTargets.every((target) => !target.installed)).toBe(true);
      expect(status.commandTargets.every((target) => !target.upToDate)).toBe(true);
      expect(status.mcpTargets).toHaveLength(4);
      expect(status.mcpTargets.every((target) => !target.installed)).toBe(true);
      expect(status.mcpTargets.every((target) => !target.upToDate)).toBe(true);

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

  it('does not mark an MCP target available when its harness is not installed', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-bundled-fakehome-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');

      const status = resolveBundledSkillsStatus({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: onlyOmpInstalled,
      });

      const byId = Object.fromEntries(status.mcpTargets.map((target) => [target.id, target]));
      expect(byId.omp?.available).toBe(true);
      expect(byId.claude?.available).toBe(false);
      expect(byId.codex?.available).toBe(false);
      expect(byId.cursor?.available).toBe(false);
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
        isInstalled: allHarnessesInstalled,
      });

      const expectedTargets = [
        join(codexHome, '.codex', 'skills'),
        join(codexHome, '.claude', 'skills'),
        join(codexHome, '.cursor', 'skills-cursor'),
        join(codexHome, '.omp', 'agent', 'skills'),
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
        const installedPlanCommand = join(targetRoot, 'invoker-plan-to-invoker.md');
        const installedLoopCommand = join(targetRoot, 'invoker-loop-generator.md');
        expect(existsSync(installedPlanCommand)).toBe(true);
        expect(existsSync(installedLoopCommand)).toBe(true);
        expect(lstatSync(installedPlanCommand).isSymbolicLink()).toBe(false);
        expect(lstatSync(installedLoopCommand).isSymbolicLink()).toBe(false);
        expect(readFileSync(installedPlanCommand, 'utf-8')).toBe('Submit with invoker_submit_plan\n');
        expect(readFileSync(installedLoopCommand, 'utf-8')).toBe('Read and follow skill://loop-generator/SKILL.md\n');
      }

      const ompMcpConfig = JSON.parse(readFileSync(join(codexHome, '.omp', 'agent', 'mcp.json'), 'utf-8'));
      expect(ompMcpConfig.$schema).toBe('https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json');
      expect(ompMcpConfig.mcpServers.invoker).toEqual({ type: 'stdio', command: 'invoker-cli', args: ['mcp'] });

      const claudeMcpConfig = JSON.parse(readFileSync(join(codexHome, '.claude.json'), 'utf-8'));
      expect(claudeMcpConfig.$schema).toBeUndefined();
      expect(claudeMcpConfig.mcpServers.invoker).toEqual({ type: 'stdio', command: 'invoker-cli', args: ['mcp'] });

      const cursorMcpConfig = JSON.parse(readFileSync(join(codexHome, '.cursor', 'mcp.json'), 'utf-8'));
      expect(cursorMcpConfig.mcpServers.invoker).toEqual({ type: 'stdio', command: 'invoker-cli', args: ['mcp'] });

      const codexToml = readFileSync(join(codexHome, '.codex', 'config.toml'), 'utf-8');
      expect(codexToml).toContain('[mcp_servers.invoker]');
      expect(codexToml).toContain('command = "invoker-cli"');
      expect(codexToml).toContain('args = ["mcp"]');

      expect(installed.targets).toHaveLength(4);
      expect(installed.commandTargets).toHaveLength(4);
      expect(installed.mcpTargets).toHaveLength(4);
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
        isInstalled: allHarnessesInstalled,
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

  it('re-running install is idempotent for the Codex TOML MCP entry', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const codexHome = makeTempRoot('invoker-codex-idempotent-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = codexHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');

      const deps = { isPackaged: true, repoRoot, resourcesPath: resourcesRoot, invokerHomeRoot, isInstalled: allHarnessesInstalled };
      installBundledSkills(deps);
      installBundledSkills(deps);

      const configPath = join(codexHome, '.codex', 'config.toml');
      const toml = readFileSync(configPath, 'utf-8');
      expect(toml.split('[mcp_servers.invoker]')).toHaveLength(2); // exactly one occurrence
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('appends to an existing Codex config.toml without disturbing its other content', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const codexHome = makeTempRoot('invoker-codex-existing-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = codexHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      const configPath = join(codexHome, '.codex', 'config.toml');
      mkdirSync(join(codexHome, '.codex'), { recursive: true });
      const preExisting = 'model = "gpt-5.5"\n\n[mcp_servers.other-tool]\ncommand = "other"\nargs = []\n';
      writeFileSync(configPath, preExisting);

      installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: allHarnessesInstalled,
      });

      const toml = readFileSync(configPath, 'utf-8');
      expect(toml).toContain(preExisting.trim());
      expect(toml).toContain('[mcp_servers.invoker]');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('does not treat a mismatched Codex TOML MCP entry as installed', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const codexHome = makeTempRoot('invoker-codex-mismatch-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = codexHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      const configPath = join(codexHome, '.codex', 'config.toml');
      mkdirSync(join(codexHome, '.codex'), { recursive: true });
      writeFileSync(configPath, [
        'model = "gpt-5.5"',
        '',
        '[mcp_servers.invoker]',
        'command = "wrong-cli"',
        'args = ["mcp"]',
        '',
      ].join('\n'));

      const before = resolveBundledSkillsStatus({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: (command) => command === 'codex',
      });
      expect(before.mcpTargets.find((target) => target.id === 'codex')?.installed).toBe(false);

      const installed = installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: (command) => command === 'codex',
      });
      const codexTarget = installed.mcpTargets.find((target) => target.id === 'codex');
      const toml = readFileSync(configPath, 'utf-8');
      expect(toml.split('[mcp_servers.invoker]')).toHaveLength(3);
      expect(toml).toContain('command = "wrong-cli"');
      expect(toml).toContain('command = "invoker-cli"');
      expect(codexTarget?.installed).toBe(true);
      expect(codexTarget?.upToDate).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('installs skills into the OMP agent skill root so omp resolves make-pr', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const ompHome = makeTempRoot('invoker-omp-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = ompHome;

    try {
      writeSkill(resourcesRoot, 'make-pr');
      writePlanToInvokerCommands(resourcesRoot);

      const installed = installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: onlyOmpInstalled,
      });

      // omp's bundledSkillRoot is ~/.omp/agent/skills; resolveSkillPathViaAgent
      // checks <root>/invoker-make-pr/SKILL.md. Without this target omp fails PR
      // publishing with `skill "invoker-make-pr" not installed` — the exact bug
      // this target prevents. omp is the default execution + PR-authoring agent.
      const ompSkillMd = join(ompHome, '.omp', 'agent', 'skills', 'invoker-make-pr', 'SKILL.md');
      expect(existsSync(ompSkillMd)).toBe(true);

      const ompTarget = installed.targets.find((target) => target.id === 'omp');
      expect(ompTarget?.path).toBe(join(ompHome, '.omp', 'agent', 'skills'));
      expect(ompTarget?.installed).toBe(true);
      expect(ompTarget?.upToDate).toBe(true);
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
        isInstalled: onlyOmpInstalled,
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

  it('preserves unrelated keys in an existing Claude Code config while adding Invoker', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-claude-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      const claudeConfigPath = join(fakeHome, '.claude.json');
      writeFileSync(claudeConfigPath, JSON.stringify({
        numStartups: 42,
        mcpServers: { 'personal-stack-planner': { type: 'stdio', command: 'bash', args: ['-lc', 'run'] } },
      }, null, 2));

      installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: (command) => command === 'claude',
      });

      const config = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
      expect(config.numStartups).toBe(42);
      expect(config.mcpServers['personal-stack-planner']).toEqual({ type: 'stdio', command: 'bash', args: ['-lc', 'run'] });
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
        isInstalled: onlyOmpInstalled,
      })).toThrow(`Invalid MCP config at ${mcpPath}: expected a JSON object`);
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
        isInstalled: onlyOmpInstalled,
      })).toThrow(`Invalid MCP config at ${mcpPath}: expected a JSON object`);
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
        isInstalled: allHarnessesInstalled,
      });

      writeFileSync(join(resourcesRoot, 'skills', 'plan-to-invoker', 'SKILL.md'), '# plan-to-invoker\n\nUpdated bundled content.\n');

      const status = resolveBundledSkillsStatus({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: allHarnessesInstalled,
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

  it('refuses to install a skill whose SKILL.md lost its YAML frontmatter', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const codexHome = makeTempRoot('invoker-codex-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = codexHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      // Simulate a botched conflict resolution that gutted SKILL.md into a git-show blob.
      const gutted = 'commit 37fa96068caa9b94559d52edf10a677a95178cf5\nAuthor: x\n\ndiff --git a/x b/x\n';
      writeFileSync(join(resourcesRoot, 'skills', 'plan-to-invoker', 'SKILL.md'), gutted);

      expect(() => installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: allHarnessesInstalled,
      })).toThrow(/missing YAML frontmatter/);

      // Nothing corrupt reached the agent skill store.
      expect(existsSync(join(codexHome, '.codex', 'skills', 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(false);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
