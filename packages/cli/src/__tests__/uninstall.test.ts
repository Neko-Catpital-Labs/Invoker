import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installBundledSkills } from '../bundled-skills.js';
import {
  discoverUninstallResources,
  executeDataPurge,
  executeNpmUninstall,
  formatCoverageTable,
  formatUninstallHelp,
  formatUninstallPlan,
  parseUninstallArgs,
  runUninstall,
  uninstallCoverageTable,
  uninstallExitCode,
  type UninstallResource,
} from '../uninstall.js';

function makeTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkill(resourcesRoot: string, name: string): void {
  const dir = join(resourcesRoot, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n\n# ${name}\n`);
}

function resource(partial: Partial<UninstallResource> & Pick<UninstallResource, 'id' | 'path' | 'scope'>): UninstallResource {
  return {
    kind: 'dedicated_file',
    detail: partial.detail ?? partial.id,
    present: partial.present ?? true,
    userModified: partial.userModified ?? false,
    ...partial,
  };
}

describe('uninstall discovery + dry-run', () => {
  let prevDbDir: string | undefined;
  let prevHome: string | undefined;
  let tempRoot = '';
  let fakeHome = '';
  let invokerHome = '';
  let resourcesRoot = '';
  let repoRoot = '';

  beforeEach(() => {
    tempRoot = makeTempRoot('invoker-uninstall-');
    fakeHome = join(tempRoot, 'home');
    invokerHome = join(tempRoot, 'invoker-home');
    resourcesRoot = join(tempRoot, 'resources');
    repoRoot = join(tempRoot, 'repo');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(invokerHome, { recursive: true });
    mkdirSync(resourcesRoot, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    prevDbDir = process.env.INVOKER_DB_DIR;
    prevHome = process.env.HOME;
    process.env.INVOKER_DB_DIR = invokerHome;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (prevDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = prevDbDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('parses uninstall flags', () => {
    expect(parseUninstallArgs(['--dry-run', '--yes', '--keep-data'])).toEqual({
      dryRun: true,
      yes: true,
      keepData: true,
      help: false,
    });
  });

  it('help documents flags, exit codes, and coverage', () => {
    const help = formatUninstallHelp();
    expect(help).toContain('--keep-data');
    expect(help).toContain('Exit codes:');
    expect(help).toContain('removed last');
    expect(help).toContain('DMG');
  });

  it('dry-run discovers owned resources and coverage without mutating disk', async () => {
    writeSkill(resourcesRoot, 'plan-to-invoker');
    const mcpPath = join(fakeHome, '.cursor', 'mcp.json');
    mkdirSync(join(fakeHome, '.cursor'), { recursive: true });
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        other: { command: 'keep-me' },
        invoker: { type: 'stdio', command: 'invoker-cli', args: ['mcp'] },
      },
    }, null, 2));

    installBundledSkills({
      isPackaged: true,
      repoRoot,
      resourcesPath: resourcesRoot,
      invokerHomeRoot: invokerHome,
      isInstalled: () => true,
    }, 'install', 'all', { registerHarnesses: true });

    const skillPath = join(invokerHome, 'skills', 'invoker-plan-to-invoker', 'SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
    const beforeMcp = readFileSync(mcpPath, 'utf8');
    const beforeSkill = readFileSync(skillPath, 'utf8');

    const lines: string[] = [];
    const code = await runUninstall(['--dry-run'], {
      print: (line) => { lines.push(line); },
      interactive: false,
    }, {
      resolveSkillsContext: () => ({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot: invokerHome,
      }),
      listGlobalNpmPackages: () => new Set(['@neko-catpital-labs/invoker-cli']),
    });

    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('Uninstall plan:');
    expect(out).toContain(mcpPath);
    expect(out).toContain(join(invokerHome, 'skills', 'invoker-plan-to-invoker'));
    expect(out).toContain('Coverage:');
    expect(out).toContain('supported');
    expect(out).toContain('excluded');
    expect(out).toContain('Dry-run complete');
    expect(readFileSync(mcpPath, 'utf8')).toBe(beforeMcp);
    expect(readFileSync(skillPath, 'utf8')).toBe(beforeSkill);
    expect(existsSync(join(invokerHome, 'bundled-skills.json'))).toBe(true);
  });

  it('format helpers include coverage rows', () => {
    const plan = formatUninstallPlan([]);
    expect(plan.join('\n')).toContain('no Invoker-owned resources found');
    expect(formatCoverageTable(uninstallCoverageTable()).join('\n')).toContain('DMG');
    expect(uninstallExitCode([{ status: 'removed' }])).toBe(0);
    expect(uninstallExitCode([{ status: 'failed: boom' }])).toBe(1);
  });
});

describe('uninstall execute integrations', () => {
  let prevDbDir: string | undefined;
  let prevHome: string | undefined;
  let prevConfig: string | undefined;
  let tempRoot = '';
  let fakeHome = '';
  let invokerHome = '';
  let resourcesRoot = '';
  let repoRoot = '';

  beforeEach(() => {
    tempRoot = makeTempRoot('invoker-uninstall-exec-');
    fakeHome = join(tempRoot, 'home');
    invokerHome = join(tempRoot, 'invoker-home');
    resourcesRoot = join(tempRoot, 'resources');
    repoRoot = join(tempRoot, 'repo');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(invokerHome, { recursive: true });
    mkdirSync(resourcesRoot, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    prevDbDir = process.env.INVOKER_DB_DIR;
    prevHome = process.env.HOME;
    prevConfig = process.env.INVOKER_REPO_CONFIG_PATH;
    process.env.INVOKER_DB_DIR = invokerHome;
    process.env.HOME = fakeHome;
    process.env.INVOKER_REPO_CONFIG_PATH = join(invokerHome, 'config.json');
  });

  afterEach(() => {
    if (prevDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = prevDbDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevConfig === undefined) delete process.env.INVOKER_REPO_CONFIG_PATH;
    else process.env.INVOKER_REPO_CONFIG_PATH = prevConfig;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('surgically removes harness MCP and skips user-modified dedicated artifacts', async () => {
    writeSkill(resourcesRoot, 'plan-to-invoker');
    const mcpPath = join(fakeHome, '.cursor', 'mcp.json');
    mkdirSync(join(fakeHome, '.cursor'), { recursive: true });
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        other: { command: 'keep-me' },
        invoker: { type: 'stdio', command: 'invoker-cli', args: ['mcp'] },
      },
    }, null, 2));

    installBundledSkills({
      isPackaged: true,
      repoRoot,
      resourcesPath: resourcesRoot,
      invokerHomeRoot: invokerHome,
      isInstalled: () => true,
    }, 'install', 'all', { registerHarnesses: true });

    const rulePath = join(fakeHome, '.cursor', 'rules', 'invoker-execution-precedence.mdc');
    expect(existsSync(rulePath)).toBe(true);
    writeFileSync(rulePath, '# user edited this rule\n');

    const skillDir = join(invokerHome, 'skills', 'invoker-plan-to-invoker');
    expect(existsSync(skillDir)).toBe(true);
    writeFileSync(join(invokerHome, 'config.json'), '{}\n');

    const lines: string[] = [];
    const code = await runUninstall(['--yes', '--keep-data'], {
      print: (line) => { lines.push(line); },
      interactive: false,
    }, {
      resolveSkillsContext: () => ({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot: invokerHome,
      }),
      listGlobalNpmPackages: () => new Set(),
    });

    expect(code).toBe(0);
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers.other).toEqual({ command: 'keep-me' });
    expect(mcp.mcpServers.invoker).toBeUndefined();
    expect(existsSync(rulePath)).toBe(true);
    expect(readFileSync(rulePath, 'utf8')).toBe('# user edited this rule\n');
    expect(existsSync(skillDir)).toBe(false);
    expect(existsSync(join(invokerHome, 'bundled-skills.json'))).toBe(false);
    expect(existsSync(join(invokerHome, 'config.json'))).toBe(true);
    const out = lines.join('\n');
    expect(out).toContain('kept (user-modified)');
    expect(out).toContain('kept (--keep-data)');
    expect(out).toContain('Remaining (kept with --keep-data)');
  });

  it('refuses non-TTY execute without --yes', async () => {
    const lines: string[] = [];
    const code = await runUninstall([], {
      print: (line) => { lines.push(line); },
      interactive: false,
    }, {
      discover: () => [resource({
        id: 'demo',
        path: '/tmp/x',
        scope: 'integration',
      })],
      listGlobalNpmPackages: () => new Set(),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('--yes');
  });

  it('discoverUninstallResources returns integration + data scopes', async () => {
    writeFileSync(join(invokerHome, 'config.json'), '{}\n');
    const resources = await discoverUninstallResources({
      resolveSkillsContext: () => ({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot: invokerHome,
      }),
      listGlobalNpmPackages: () => new Set(['@neko-catpital-labs/invoker-ui']),
    });
    expect(resources.some((entry) => entry.scope === 'data')).toBe(true);
    expect(resources.some((entry) => entry.id === 'npm:@neko-catpital-labs/invoker-ui')).toBe(true);
  });
});

describe('uninstall data + npm + exit codes', () => {
  let prevDbDir: string | undefined;
  let prevHome: string | undefined;
  let prevConfig: string | undefined;
  let tempRoot = '';
  let fakeHome = '';
  let invokerHome = '';
  let resourcesRoot = '';
  let repoRoot = '';

  beforeEach(() => {
    tempRoot = makeTempRoot('invoker-uninstall-data-');
    fakeHome = join(tempRoot, 'home');
    invokerHome = join(tempRoot, 'invoker-home');
    resourcesRoot = join(tempRoot, 'resources');
    repoRoot = join(tempRoot, 'repo');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(invokerHome, { recursive: true });
    mkdirSync(resourcesRoot, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    prevDbDir = process.env.INVOKER_DB_DIR;
    prevHome = process.env.HOME;
    prevConfig = process.env.INVOKER_REPO_CONFIG_PATH;
    process.env.INVOKER_DB_DIR = invokerHome;
    process.env.HOME = fakeHome;
    process.env.INVOKER_REPO_CONFIG_PATH = join(invokerHome, 'config.json');
  });

  afterEach(() => {
    if (prevDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = prevDbDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevConfig === undefined) delete process.env.INVOKER_REPO_CONFIG_PATH;
    else process.env.INVOKER_REPO_CONFIG_PATH = prevConfig;
    try {
      chmodSync(invokerHome, 0o755);
    } catch {
      // home may already be gone
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('purges home data by default and removes npm packages last', async () => {
    writeFileSync(join(invokerHome, 'config.json'), '{}\n');
    writeFileSync(join(invokerHome, '.env'), 'TOKEN=x\n');
    const callOrder: string[] = [];
    const lines: string[] = [];
    const code = await runUninstall(['--yes'], {
      print: (line) => { lines.push(line); },
      interactive: false,
    }, {
      discover: () => [
        resource({
          id: 'integration:demo',
          path: join(tempRoot, 'integration-marker'),
          scope: 'integration',
          kind: 'dedicated_file',
        }),
        resource({
          id: `data:home:${invokerHome}`,
          path: invokerHome,
          scope: 'data',
          kind: 'invoker_home_data',
          detail: 'Invoker home root (persistent data)',
        }),
        resource({
          id: `data:config:${invokerHome}`,
          path: join(invokerHome, 'config.json'),
          scope: 'data',
          kind: 'invoker_home_data',
          detail: 'config.json',
        }),
        resource({
          id: 'npm:@neko-catpital-labs/invoker-cli',
          path: '@neko-catpital-labs/invoker-cli',
          scope: 'npm',
          kind: 'npm_package',
        }),
      ],
      executeIntegrations: async () => {
        callOrder.push('integrations');
        return [{
          resource: resource({
            id: 'integration:demo',
            path: join(tempRoot, 'integration-marker'),
            scope: 'integration',
          }),
          status: 'removed',
        }];
      },
      removePath: (targetPath) => {
        callOrder.push(`data:${targetPath}`);
        defaultRemoveViaFs(targetPath);
      },
      uninstallNpmPackage: (packageName) => {
        callOrder.push(`npm:${packageName}`);
      },
      listGlobalNpmPackages: () => new Set(['@neko-catpital-labs/invoker-cli']),
    });

    expect(code).toBe(0);
    expect(callOrder[0]).toBe('integrations');
    expect(callOrder.some((entry) => entry.startsWith('data:'))).toBe(true);
    expect(callOrder.at(-1)).toBe('npm:@neko-catpital-labs/invoker-cli');
    expect(existsSync(invokerHome)).toBe(false);
    expect(lines.join('\n')).toContain('removed: [npm_package]');
  });

  it('keeps home data with --keep-data and still uninstalls npm', async () => {
    writeFileSync(join(invokerHome, 'config.json'), '{}\n');
    const npmCalls: string[] = [];
    const lines: string[] = [];
    const code = await runUninstall(['--yes', '--keep-data'], {
      print: (line) => { lines.push(line); },
      interactive: false,
    }, {
      discover: () => [
        resource({
          id: `data:home:${invokerHome}`,
          path: invokerHome,
          scope: 'data',
          kind: 'invoker_home_data',
        }),
        resource({
          id: 'npm:@neko-catpital-labs/invoker-ui',
          path: '@neko-catpital-labs/invoker-ui',
          scope: 'npm',
          kind: 'npm_package',
        }),
      ],
      executeIntegrations: async () => [],
      uninstallNpmPackage: (packageName) => { npmCalls.push(packageName); },
    });

    expect(code).toBe(0);
    expect(existsSync(join(invokerHome, 'config.json'))).toBe(true);
    expect(npmCalls).toEqual(['@neko-catpital-labs/invoker-ui']);
    expect(lines.join('\n')).toContain('kept (--keep-data)');
    expect(lines.join('\n')).toContain('Remaining (kept with --keep-data)');
  });

  it('reports permission failures and exits non-zero', async () => {
    const homeResource = resource({
      id: `data:home:${invokerHome}`,
      path: invokerHome,
      scope: 'data',
      kind: 'invoker_home_data',
    });
    const results = executeDataPurge([homeResource], { keepData: false }, {
      removePath: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(results[0]?.status).toBe('failed: EACCES: permission denied');
    expect(uninstallExitCode(results)).toBe(1);

    const lines: string[] = [];
    const code = await runUninstall(['--yes'], {
      print: (line) => { lines.push(line); },
      interactive: false,
    }, {
      discover: () => [homeResource],
      executeIntegrations: async () => [],
      removePath: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('failed: EACCES: permission denied');
  });

  it('treats missing resources and repeated uninstall as success', async () => {
    const lines: string[] = [];
    const code = await runUninstall(['--yes'], {
      print: (line) => { lines.push(line); },
      interactive: false,
    }, {
      discover: () => [],
      executeIntegrations: async () => [],
      listGlobalNpmPackages: () => new Set(),
    });
    expect(code).toBe(0);

    const absent = executeDataPurge([
      resource({
        id: 'data:home:/missing',
        path: join(tempRoot, 'does-not-exist'),
        scope: 'data',
        kind: 'invoker_home_data',
        present: true,
      }),
    ], { keepData: false });
    expect(absent[0]?.status).toBe('absent');
    expect(uninstallExitCode(absent)).toBe(0);

    const npmAbsent = executeNpmUninstall([], {});
    expect(npmAbsent).toEqual([]);
  });

  it('completes after an interrupted mid-uninstall when re-run', async () => {
    writeSkill(resourcesRoot, 'plan-to-invoker');
    const mcpPath = join(fakeHome, '.cursor', 'mcp.json');
    mkdirSync(join(fakeHome, '.cursor'), { recursive: true });
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        other: { command: 'keep-me' },
        invoker: { type: 'stdio', command: 'invoker-cli', args: ['mcp'] },
      },
    }, null, 2));
    installBundledSkills({
      isPackaged: true,
      repoRoot,
      resourcesPath: resourcesRoot,
      invokerHomeRoot: invokerHome,
      isInstalled: () => true,
    }, 'install', 'all', { registerHarnesses: true });
    writeFileSync(join(invokerHome, 'config.json'), '{}\n');

    const skillDir = join(invokerHome, 'skills', 'invoker-plan-to-invoker');
    expect(existsSync(skillDir)).toBe(true);

    // Simulate interrupt after integrations only (data/npm not yet run).
    const partialCode = await runUninstall(['--yes', '--keep-data'], {
      print: () => {},
      interactive: false,
    }, {
      resolveSkillsContext: () => ({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot: invokerHome,
      }),
      listGlobalNpmPackages: () => new Set(['@neko-catpital-labs/invoker-cli']),
      uninstallNpmPackage: () => {
        throw new Error('interrupted before npm');
      },
    });
    expect(partialCode).toBe(1);
    expect(existsSync(skillDir)).toBe(false);
    expect(existsSync(join(invokerHome, 'config.json'))).toBe(true);
    const mcpAfterPartial = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcpAfterPartial.mcpServers.other).toEqual({ command: 'keep-me' });
    expect(mcpAfterPartial.mcpServers.invoker).toBeUndefined();

    const npmCalls: string[] = [];
    const resumeCode = await runUninstall(['--yes'], {
      print: () => {},
      interactive: false,
    }, {
      resolveSkillsContext: () => ({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot: invokerHome,
      }),
      listGlobalNpmPackages: () => new Set(['@neko-catpital-labs/invoker-cli']),
      uninstallNpmPackage: (packageName) => { npmCalls.push(packageName); },
    });
    expect(resumeCode).toBe(0);
    expect(existsSync(invokerHome)).toBe(false);
    expect(npmCalls).toEqual(['@neko-catpital-labs/invoker-cli']);
  });

  it('covers mixed/partial install paths without requiring every resource', async () => {
    writeFileSync(join(invokerHome, 'config.json'), '{}\n');
    const mcpPath = join(fakeHome, '.cursor', 'mcp.json');
    mkdirSync(join(fakeHome, '.cursor'), { recursive: true });
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        other: { command: 'keep-me' },
        invoker: { type: 'stdio', command: 'invoker-cli', args: ['mcp'] },
      },
    }, null, 2));

    const code = await runUninstall(['--yes', '--keep-data'], {
      print: () => {},
      interactive: false,
    }, {
      resolveSkillsContext: () => ({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot: invokerHome,
      }),
      listGlobalNpmPackages: () => new Set(),
    });

    expect(code).toBe(0);
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers.other).toEqual({ command: 'keep-me' });
    expect(mcp.mcpServers.invoker).toBeUndefined();
    expect(existsSync(join(invokerHome, 'config.json'))).toBe(true);
  });
});

function defaultRemoveViaFs(targetPath: string): void {
  if (!existsSync(targetPath)) return;
  rmSync(targetPath, { recursive: true, force: true });
}
