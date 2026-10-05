import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { installBundledSkills, resolveBundledSkillsStatus } from '../bundled-skills.js';

const tempRoots: string[] = [];

/** Deterministic stand-ins for `commandExists` — never probe the real machine in tests. */
const allHarnessesInstalled = () => true;
const onlyOmpInstalled = (command: string) => command === 'omp';

function packagedInstall(
  resourcesRoot: string,
  repoRoot: string,
  invokerHomeRoot: string,
  isInstalled: (command: string) => boolean = onlyOmpInstalled,
) {
  return installBundledSkills({
    isPackaged: true,
    repoRoot,
    resourcesPath: resourcesRoot,
    invokerHomeRoot,
    isInstalled,
  });
}

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

      expect(status.commandTargets).toHaveLength(1);
      expect(status.commandTargets[0]?.id).toBe('invoker');
      expect(status.commandTargets.every((target) => !target.installed)).toBe(true);
      expect(status.commandTargets.every((target) => !target.upToDate)).toBe(true);
      expect(status.targets).toHaveLength(1);
      expect(status.targets[0]?.id).toBe('invoker');
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

  it('installs prefixed skill copies under Invoker home only and leaves harness configs untouched', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-codex-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

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

      expect(existsSync(join(invokerHomeRoot, 'skills', 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(invokerHomeRoot, 'skills', 'invoker-make-pr', 'scripts', 'check.sh'))).toBe(true);
      expect(existsSync(join(invokerHomeRoot, 'commands', 'invoker-plan-to-invoker.md'))).toBe(true);
      expect(existsSync(join(invokerHomeRoot, 'commands', 'invoker-loop-generator.md'))).toBe(true);
      const snippet = JSON.parse(readFileSync(join(invokerHomeRoot, 'mcp-servers', 'invoker.json'), 'utf-8'));
      expect(snippet.mcpServers.invoker).toEqual({ type: 'stdio', command: 'invoker-cli', args: ['mcp'] });

      for (const harnessPath of [
        join(fakeHome, '.codex', 'skills'),
        join(fakeHome, '.claude', 'skills'),
        join(fakeHome, '.cursor', 'skills'),
        join(fakeHome, '.omp', 'agent', 'skills'),
        join(fakeHome, '.cursor', 'mcp.json'),
        join(fakeHome, '.claude.json'),
        join(fakeHome, '.codex', 'config.toml'),
        join(fakeHome, '.omp', 'agent', 'mcp.json'),
        join(fakeHome, '.cursor', 'rules', 'invoker-execution-precedence.mdc'),
      ]) {
        expect(existsSync(harnessPath)).toBe(false);
      }

      expect(installed.targets).toHaveLength(1);
      expect(installed.commandTargets).toHaveLength(1);
      expect(installed.targets.every((target) => target.installed)).toBe(true);
      expect(installed.targets.every((target) => target.upToDate)).toBe(true);
      expect(installed.commandTargets.every((target) => target.installed)).toBe(true);
      expect(installed.commandTargets.every((target) => target.upToDate)).toBe(true);
      expect(installed.mcpTargets.every((target) => !target.installed)).toBe(true);
      expect(installed.instructionTargets?.every((target) => !target.installed)).toBe(true);
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
      expect(status.promptRecommended).toBe(false);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('re-running install is idempotent for the Invoker MCP snippet', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-codex-idempotent-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');

      const deps = { isPackaged: true, repoRoot, resourcesPath: resourcesRoot, invokerHomeRoot, isInstalled: allHarnessesInstalled };
      installBundledSkills(deps);
      installBundledSkills(deps);

      const snippetPath = join(invokerHomeRoot, 'mcp-servers', 'invoker.json');
      const first = readFileSync(snippetPath, 'utf-8');
      expect(JSON.parse(first).mcpServers.invoker).toEqual({ type: 'stdio', command: 'invoker-cli', args: ['mcp'] });
      expect(existsSync(join(fakeHome, '.codex', 'config.toml'))).toBe(false);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('does not modify an existing Codex config.toml during default install', () => {
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

      expect(readFileSync(configPath, 'utf-8')).toBe(preExisting);
      expect(existsSync(join(invokerHomeRoot, 'mcp-servers', 'invoker.json'))).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('leaves a mismatched Codex TOML MCP entry untouched on default install', () => {
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
      const mismatched = [
        'model = "gpt-5.5"',
        '',
        '[mcp_servers.invoker]',
        'command = "wrong-cli"',
        'args = ["mcp"]',
        '',
      ].join('\n');
      writeFileSync(configPath, mismatched);

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
      expect(readFileSync(configPath, 'utf-8')).toBe(mismatched);
      expect(existsSync(join(invokerHomeRoot, 'mcp-servers', 'invoker.json'))).toBe(true);
      expect(codexTarget?.installed).toBe(false);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('installs skills under Invoker home instead of the OMP agent skill root', () => {
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

      expect(existsSync(join(invokerHomeRoot, 'skills', 'invoker-make-pr', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(ompHome, '.omp', 'agent', 'skills', 'invoker-make-pr', 'SKILL.md'))).toBe(false);

      const invokerTarget = installed.targets.find((target) => target.id === 'invoker');
      expect(invokerTarget?.path).toBe(join(invokerHomeRoot, 'skills'));
      expect(invokerTarget?.installed).toBe(true);
      expect(invokerTarget?.upToDate).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('leaves an existing OMP MCP config byte-identical', () => {
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
      const prior = `${JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['server'] } } }, null, 2)}\n`;
      writeFileSync(mcpPath, prior);

      installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: onlyOmpInstalled,
      });

      expect(readFileSync(mcpPath, 'utf-8')).toBe(prior);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('leaves an existing Claude Code config byte-identical', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-claude-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      const claudeConfigPath = join(fakeHome, '.claude.json');
      const prior = `${JSON.stringify({
        numStartups: 42,
        mcpServers: { 'personal-stack-planner': { type: 'stdio', command: 'bash', args: ['-lc', 'run'] } },
      }, null, 2)}\n`;
      writeFileSync(claudeConfigPath, prior);

      installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: (command) => command === 'claude',
      });

      expect(readFileSync(claudeConfigPath, 'utf-8')).toBe(prior);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('succeeds when harness MCP JSON is invalid because it no longer reads those files', () => {
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

      const installed = packagedInstall(resourcesRoot, repoRoot, invokerHomeRoot);
      expect(readFileSync(mcpPath, 'utf-8')).toBe('[]');
      expect(installed.lastInstallError).toBeUndefined();
      expect(existsSync(join(invokerHomeRoot, 'skills', 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('succeeds when harness MCP JSON is malformed because it no longer reads those files', () => {
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

      const installed = packagedInstall(resourcesRoot, repoRoot, invokerHomeRoot);
      expect(readFileSync(mcpPath, 'utf-8')).toBe('{"mcpServers":');
      expect(installed.lastInstallError).toBeUndefined();
      expect(existsSync(join(invokerHomeRoot, 'skills', 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('leaves a bad Cursor MCP file untouched and still installs under Invoker home', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-cursor-invalid-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      const cursorMcpPath = join(fakeHome, '.cursor', 'mcp.json');
      mkdirSync(join(fakeHome, '.cursor'), { recursive: true });
      writeFileSync(cursorMcpPath, '[]');

      const installed = packagedInstall(resourcesRoot, repoRoot, invokerHomeRoot, allHarnessesInstalled);
      expect(readFileSync(cursorMcpPath, 'utf-8')).toBe('[]');
      expect(installed.lastInstallError).toBeUndefined();
      expect(existsSync(join(invokerHomeRoot, 'skills', 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(fakeHome, '.omp', 'agent', 'mcp.json'))).toBe(false);
      expect(existsSync(join(fakeHome, '.claude.json'))).toBe(false);
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

  it('records the source checkout in the manifest for the unpackaged CLI install, so installed doctor scripts outside any git repo (e.g. ~/.invoker/skills/invoker-plan-to-invoker/scripts) can still resolve their Invoker checkout', () => {
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const cliHome = makeTempRoot('invoker-cli-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = cliHome;

    try {
      writeSkill(repoRoot, 'plan-to-invoker');
      writePlanToInvokerCommands(repoRoot);

      installBundledSkills({
        isPackaged: false,
        repoRoot,
        invokerHomeRoot,
        isInstalled: allHarnessesInstalled,
      });

      const manifest = JSON.parse(readFileSync(join(invokerHomeRoot, 'bundled-skills.json'), 'utf-8'));
      expect(manifest.sourceRepoRoot).toBe(repoRoot);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('records yamlModuleRoot for a packaged install, pointing at a directory that holds node_modules/yaml', () => {
    const packageRoot = makeTempRoot('invoker-bundled-package-');
    const resourcesRoot = join(packageRoot, 'vendor', 'Invoker.app', 'Contents', 'Resources');
    mkdirSync(resourcesRoot, { recursive: true });
    mkdirSync(join(packageRoot, 'node_modules', 'yaml', 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'node_modules', 'yaml', 'dist', 'index.js'), 'export const parse = () => {};');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const codexHome = makeTempRoot('invoker-codex-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = codexHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      writePlanToInvokerCommands(resourcesRoot);

      installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: allHarnessesInstalled,
      });

      const manifest = JSON.parse(readFileSync(join(invokerHomeRoot, 'bundled-skills.json'), 'utf-8'));
      expect(manifest.sourceRepoRoot).toBeUndefined();
      expect(manifest.yamlModuleRoot).toBe(packageRoot);
      expect(existsSync(join(manifest.yamlModuleRoot, 'node_modules', 'yaml', 'dist', 'index.js'))).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('omits yamlModuleRoot when no reachable node_modules/yaml exists', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const codexHome = makeTempRoot('invoker-codex-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = codexHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      writePlanToInvokerCommands(resourcesRoot);

      installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: allHarnessesInstalled,
      });

      const manifest = JSON.parse(readFileSync(join(invokerHomeRoot, 'bundled-skills.json'), 'utf-8'));
      expect(manifest.yamlModuleRoot).toBeUndefined();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('omits sourceRepoRoot for packaged Electron installs, whose resources dir is not a real Invoker checkout', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const codexHome = makeTempRoot('invoker-codex-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = codexHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      writePlanToInvokerCommands(resourcesRoot);

      installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: allHarnessesInstalled,
      });

      const manifest = JSON.parse(readFileSync(join(invokerHomeRoot, 'bundled-skills.json'), 'utf-8'));
      expect(manifest.sourceRepoRoot).toBeUndefined();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('does not install always-on routing into Cursor, Codex, or Claude on default install', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-instruction-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      writePlanToInvokerCommands(resourcesRoot);
      mkdirSync(join(fakeHome, '.codex'), { recursive: true });
      writeFileSync(join(fakeHome, '.codex', 'AGENTS.md'), '# Personal rules\n\nKeep me.\n');
      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      const settingsPrior = `${JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'python3 other.py' }] },
          ],
        },
      }, null, 2)}\n`;
      writeFileSync(join(fakeHome, '.claude', 'settings.json'), settingsPrior);

      const installed = installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: allHarnessesInstalled,
      });

      expect(existsSync(join(invokerHomeRoot, 'skills', 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(fakeHome, '.cursor', 'skills', 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(false);
      expect(existsSync(join(fakeHome, '.cursor', 'rules', 'invoker-execution-precedence.mdc'))).toBe(false);
      expect(readFileSync(join(fakeHome, '.codex', 'AGENTS.md'), 'utf-8')).toBe('# Personal rules\n\nKeep me.\n');
      expect(readFileSync(join(fakeHome, '.claude', 'settings.json'), 'utf-8')).toBe(settingsPrior);
      expect(existsSync(join(invokerHomeRoot, 'hooks', 'invoker-execution', 'claude_prompt_submit.mjs'))).toBe(false);
      expect(installed.instructionTargets?.every((target) => !target.installed)).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('uninstall reverses Invoker-home writes and leaves unrelated harness files', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-uninstall-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      writePlanToInvokerCommands(resourcesRoot);
      mkdirSync(join(fakeHome, '.codex'), { recursive: true });
      writeFileSync(join(fakeHome, '.codex', 'AGENTS.md'), 'Keep me.\n');
      mkdirSync(join(fakeHome, '.cursor', 'skills-cursor', 'invoker-plan-to-invoker'), { recursive: true });
      writeFileSync(join(fakeHome, '.cursor', 'skills-cursor', 'invoker-plan-to-invoker', 'SKILL.md'), 'legacy\n');

      const deps = {
        isPackaged: true as const,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: allHarnessesInstalled,
      };
      installBundledSkills(deps);
      expect(existsSync(join(invokerHomeRoot, 'skills', 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(invokerHomeRoot, 'mcp-servers', 'invoker.json'))).toBe(true);

      const uninstalled = installBundledSkills(deps, 'uninstall');

      expect(existsSync(join(invokerHomeRoot, 'skills', 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(false);
      expect(existsSync(join(invokerHomeRoot, 'commands', 'invoker-plan-to-invoker.md'))).toBe(false);
      expect(existsSync(join(invokerHomeRoot, 'mcp-servers', 'invoker.json'))).toBe(false);
      expect(existsSync(join(invokerHomeRoot, 'bundled-skills.json'))).toBe(false);
      expect(existsSync(join(fakeHome, '.cursor', 'skills-cursor', 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(false);
      expect(readFileSync(join(fakeHome, '.codex', 'AGENTS.md'), 'utf-8')).toBe('Keep me.\n');
      expect(uninstalled.targets.every((target) => !target.installed)).toBe(true);

      expect(() => installBundledSkills(deps, 'uninstall')).not.toThrow();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('leaves invalid Claude settings.json untouched because default install never opens it', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-invalid-settings-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      const settingsPath = join(fakeHome, '.claude', 'settings.json');
      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      writeFileSync(settingsPath, '[]');

      const installed = packagedInstall(resourcesRoot, repoRoot, invokerHomeRoot, allHarnessesInstalled);
      expect(readFileSync(settingsPath, 'utf-8')).toBe('[]');
      expect(installed.lastInstallError).toBeUndefined();
      expect(existsSync(join(invokerHomeRoot, 'skills', 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('reports instruction targets as not installed after default install', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const fakeHome = makeTempRoot('invoker-stale-instruction-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: allHarnessesInstalled,
      });

      const status = resolveBundledSkillsStatus({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
        isInstalled: allHarnessesInstalled,
      });
      expect(status.instructionTargets?.every((target) => !target.installed)).toBe(true);
      expect(status.targets.every((target) => target.installed && target.upToDate)).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
