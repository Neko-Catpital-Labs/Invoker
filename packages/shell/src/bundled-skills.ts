import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { resolveInvokerHomeRoot, type IsInstalled } from '@invoker/contracts';
import type {
  HarnessConfigState,
  HarnessMcpConfigState,
  BundledSkillsInstallMode,
  BundledSkillsStatus,
  BundledSkillTargetStatus,
} from '@invoker/contracts';

import { commandExists } from './command-exists.js';

const MANAGED_PREFIX = 'invoker-';
const MANIFEST_FILE = 'bundled-skills.json';
const OMP_MCP_SCHEMA_URL = 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json';
const INVOKER_MCP_SERVER = { type: 'stdio', command: 'invoker-cli', args: ['mcp'] } as const;
const INVOKER_MCP_SERVER_NAME = 'invoker';

interface BundledSkillsManifest {
  bundledHash: string;
  bundledSkillNames: string[];
  installedAt: string;
  lastInstallError?: string;
  targets: Record<string, { path: string; installedSkillNames: string[] }>;
  commandTargets?: Record<string, { path: string; installedCommandNames: string[] }>;
  mcpTargets?: Record<string, { path: string; serverName: string }>;
}

interface BundledSkillsContext {
  isPackaged: boolean;
  repoRoot: string;
  resourcesPath?: string;
  invokerHomeRoot?: string;
  /** Injectable for tests; defaults to real `command -v` probing. */
  isInstalled?: IsInstalled;
}

type JsonRecord = Record<string, unknown>;
type BundledSkillStaleReason = NonNullable<BundledSkillTargetStatus['staleReason']>;
type McpConfigFormat = 'json' | 'toml';

/** Only set inside a packaged Electron app (packages/app); undefined for the standalone CLI. */
function electronResourcesPath(): string | undefined {
  return (process as unknown as { resourcesPath?: string }).resourcesPath;
}

function resolveBundledSkillsSourceRoot(context: BundledSkillsContext): string | null {
  if (context.isPackaged) {
    const resourceRoot = context.resourcesPath ?? electronResourcesPath();
    if (!resourceRoot) return null;
    const packagedSkills = path.join(resourceRoot, 'skills');
    return existsSync(packagedSkills) ? packagedSkills : null;
  }

  const repoSkills = path.join(context.repoRoot, 'skills');
  return existsSync(repoSkills) ? repoSkills : null;
}

function listBundledSkillNames(sourceRoot: string): string[] {
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(sourceRoot, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

/** A SKILL.md must open with a YAML frontmatter block (`---` … `---`); the agent
 * runtimes (codex, claude, omp) reject one without it. A botched stacked-PR
 * conflict resolution has gutted plan-to-invoker/SKILL.md into a raw `git show`
 * blob before (commit fd5c6bbfc), and the old blind cpSync then mirrored that
 * corruption into every agent's global skill store — poisoning executions on
 * every branch, since the store lives outside the per-worktree sandbox. Fail the
 * install loudly instead of propagating a skill no agent can load. */
function assertSkillSourceValid(sourceDir: string, skillName: string): void {
  const skillMd = path.join(sourceDir, 'SKILL.md');
  const content = readFileSync(skillMd, 'utf8');
  const lines = content.split('\n');
  const hasFrontmatter = lines[0]?.trim() === '---'
    && lines.slice(1).some((line) => line.trim() === '---');
  if (!hasFrontmatter) {
    const preview = content.slice(0, 80).replace(/\s+/g, ' ').trim();
    throw new Error(
      `Bundled skill "${skillName}" has a corrupt SKILL.md at ${skillMd}: missing YAML `
      + 'frontmatter delimited by ---. The bundled source looks damaged (starts with '
      + `"${preview}"). Restore it from a clean checkout, then reinstall skills.`,
    );
  }
}

function hashDirectory(root: string): string {
  const hash = createHash('sha256');

  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        hash.update(`dir:${relative}`);
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(`file:${relative}`);
      hash.update(readFileSync(absolute));
    }
  };

  walk(root);
  return hash.digest('hex');
}

function resolveCodexTarget(): BundledSkillTargetStatus {
  return {
    id: 'codex',
    name: 'Codex',
    path: path.join(homedir(), '.codex', 'skills'),
    available: true,
    installed: false,
    upToDate: false,
    installedSkillNames: [],
  };
}

function resolveClaudeTarget(): BundledSkillTargetStatus {
  return {
    id: 'claude',
    name: 'Claude',
    path: path.join(homedir(), '.claude', 'skills'),
    available: true,
    installed: false,
    upToDate: false,
    installedSkillNames: [],
  };
}

function resolveCursorTarget(): BundledSkillTargetStatus {
  return {
    id: 'cursor',
    name: 'Cursor',
    path: path.join(homedir(), '.cursor', 'skills-cursor'),
    available: true,
    installed: false,
    upToDate: false,
    installedSkillNames: [],
  };
}

function resolveOmpSkillTarget(): BundledSkillTargetStatus {
  return {
    id: 'omp',
    name: 'OMP',
    path: path.join(homedir(), '.omp', 'agent', 'skills'),
    available: true,
    installed: false,
    upToDate: false,
    installedSkillNames: [],
  };
}

function resolveManagedTargets(): BundledSkillTargetStatus[] {
  return [resolveCodexTarget(), resolveClaudeTarget(), resolveCursorTarget(), resolveOmpSkillTarget()];
}

function resolveManagedCommandTargets(): HarnessConfigState[] {
  return [
    {
      id: 'codex',
      name: 'Codex',
      path: path.join(homedir(), '.codex', 'commands'),
      available: true,
      installed: false,
      upToDate: false,
      installedCommandNames: [],
    },
    {
      id: 'claude',
      name: 'Claude',
      path: path.join(homedir(), '.claude', 'commands'),
      available: true,
      installed: false,
      upToDate: false,
      installedCommandNames: [],
    },
    {
      id: 'cursor',
      name: 'Cursor',
      path: path.join(homedir(), '.cursor', 'commands'),
      available: true,
      installed: false,
      upToDate: false,
      installedCommandNames: [],
    },
    {
      id: 'omp',
      name: 'OMP',
      path: path.join(homedir(), '.omp', 'agent', 'commands'),
      available: true,
      installed: false,
      upToDate: false,
      installedCommandNames: [],
    },
  ];
}

interface McpTargetCandidate extends HarnessMcpConfigState {
  format: McpConfigFormat;
  /** Command probed via `isInstalled` to decide `available`. */
  probeCommand: string;
}

/**
 * MCP registration is per-harness config, not a shared file like skills/commands
 * are, so — unlike resolveManagedTargets above — this only registers a harness
 * that's actually installed, checked via `isInstalled` (defaults to real
 * `command -v` probing). Each harness stores MCP servers differently:
 * Claude Code and Cursor use their own JSON config, Codex uses TOML.
 */
function resolveManagedMcpTargets(isInstalled: IsInstalled = commandExists): McpTargetCandidate[] {
  const candidates: Array<Omit<McpTargetCandidate, 'available'>> = [
    {
      id: 'claude',
      name: 'Claude',
      path: path.join(homedir(), '.claude.json'),
      installed: false,
      upToDate: false,
      serverName: INVOKER_MCP_SERVER_NAME,
      format: 'json',
      probeCommand: 'claude',
    },
    {
      id: 'codex',
      name: 'Codex',
      path: path.join(homedir(), '.codex', 'config.toml'),
      installed: false,
      upToDate: false,
      serverName: INVOKER_MCP_SERVER_NAME,
      format: 'toml',
      probeCommand: 'codex',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      path: path.join(homedir(), '.cursor', 'mcp.json'),
      installed: false,
      upToDate: false,
      serverName: INVOKER_MCP_SERVER_NAME,
      format: 'json',
      probeCommand: 'cursor',
    },
    {
      id: 'omp',
      name: 'OMP',
      path: path.join(homedir(), '.omp', 'agent', 'mcp.json'),
      installed: false,
      upToDate: false,
      serverName: INVOKER_MCP_SERVER_NAME,
      format: 'json',
      probeCommand: 'omp',
    },
  ];
  return candidates.map((candidate) => ({ ...candidate, available: isInstalled(candidate.probeCommand) }));
}

function resolveManifestPath(invokerHomeRoot: string): string {
  return path.join(invokerHomeRoot, MANIFEST_FILE);
}

function readManifest(invokerHomeRoot: string): BundledSkillsManifest | null {
  const manifestPath = resolveManifestPath(invokerHomeRoot);
  if (!existsSync(manifestPath)) return null;

  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as BundledSkillsManifest;
  } catch {
    return null;
  }
}

function writeManifest(invokerHomeRoot: string, manifest: BundledSkillsManifest): void {
  mkdirSync(invokerHomeRoot, { recursive: true });
  writeFileSync(resolveManifestPath(invokerHomeRoot), JSON.stringify(manifest, null, 2));
}

function resolveStaleReason(
  target: BundledSkillTargetStatus,
  installed: boolean,
  upToDate: boolean,
  manifest: BundledSkillsManifest | null,
  bundledHash: string,
): BundledSkillStaleReason | undefined {
  if (!installed) return 'not-installed';
  if (upToDate) return undefined;
  if (!manifest) return 'manifest-missing';
  const manifestTarget = manifest.targets[target.id];
  if (!manifestTarget) return 'manifest-target-missing';
  if (manifestTarget.path !== target.path) return 'target-path-changed';
  if (manifest.bundledHash !== bundledHash) return 'bundle-updated';
  return 'manifest-skill-list-changed';
}

function staleDiagnostic(
  staleReason: BundledSkillStaleReason,
  target: BundledSkillTargetStatus,
  missingSkillNames: string[],
  manifestTarget: BundledSkillsManifest['targets'][string] | undefined,
): string {
  switch (staleReason) {
    case 'not-installed':
      return missingSkillNames.length > 0
        ? `Missing managed skills with prefix "${MANAGED_PREFIX}": ${missingSkillNames.join(', ')}`
        : `Managed skills with prefix "${MANAGED_PREFIX}" are not installed.`;
    case 'manifest-missing':
      return `Installed managed skills with prefix "${MANAGED_PREFIX}" exist, but Invoker has no install manifest. Reinstall to verify the bundle version.`;
    case 'manifest-target-missing':
      return `Installed managed skills with prefix "${MANAGED_PREFIX}" exist, but the install manifest has no ${target.name} target entry. Reinstall to refresh diagnostics.`;
    case 'target-path-changed':
      return `Installed managed skills with prefix "${MANAGED_PREFIX}" are recorded for ${manifestTarget?.path}, not ${target.path}. Reinstall to update this target.`;
    case 'bundle-updated':
      return `Installed managed skills with prefix "${MANAGED_PREFIX}" are stale because the bundled source changed. Update skills to refresh them.`;
    case 'manifest-skill-list-changed':
      return `Installed managed skills with prefix "${MANAGED_PREFIX}" differ from the bundled skill manifest. Reinstall to restore the managed set.`;
  }
}

function buildTargetDiagnostic(
  staleReason: BundledSkillStaleReason | undefined,
  target: BundledSkillTargetStatus,
  missingSkillNames: string[],
  manifestTarget: BundledSkillsManifest['targets'][string] | undefined,
): string {
  if (!staleReason) {
    return `Installed managed skills with prefix "${MANAGED_PREFIX}" are up to date.`;
  }
  return staleDiagnostic(staleReason, target, missingSkillNames, manifestTarget);
}

function buildTargetStatus(
  target: BundledSkillTargetStatus,
  expectedInstalledNames: string[],
  bundledHash: string,
  manifest: BundledSkillsManifest | null,
): BundledSkillTargetStatus {
  const installedSkillNames = expectedInstalledNames.filter((name) => existsSync(path.join(target.path, name, 'SKILL.md')));
  const missingSkillNames = expectedInstalledNames.filter((name) => !installedSkillNames.includes(name));
  const installed = installedSkillNames.length === expectedInstalledNames.length;
  const manifestTarget = manifest?.targets[target.id];
  const upToDate = installed
    && manifest?.bundledHash === bundledHash
    && manifestTarget?.path === target.path
    && expectedInstalledNames.every((name) => manifestTarget.installedSkillNames.includes(name));
  const staleReason = resolveStaleReason(target, installed, upToDate, manifest, bundledHash);
  const diagnostic = buildTargetDiagnostic(staleReason, target, missingSkillNames, manifestTarget);

  return {
    ...target,
    installed,
    upToDate,
    installedSkillNames,
    missingSkillNames,
    staleReason,
    diagnostic,
  };
}

function managedSkillName(skillName: string): string {
  return `${MANAGED_PREFIX}${skillName}`;
}

function prefixedSkillNames(skillNames: string[]): string[] {
  return skillNames.map(managedSkillName);
}

function commandSourceDir(sourceRoot: string): string {
  return path.join(sourceRoot, 'plan-to-invoker', 'commands');
}

function listCommandNames(sourceRoot: string): string[] {
  const sourceDir = commandSourceDir(sourceRoot);
  if (!existsSync(sourceDir)) return [];
  return readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

function commandDisplayName(fileName: string): string {
  return fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
}

function buildCommandConfigState(
  target: HarnessConfigState,
  expectedCommandFiles: string[],
  bundledHash: string,
  manifest: BundledSkillsManifest | null,
): HarnessConfigState {
  const installedFiles = expectedCommandFiles.filter((fileName) => existsSync(path.join(target.path, fileName)));
  const installedCommandNames = installedFiles.map(commandDisplayName);
  const expectedCommandNames = expectedCommandFiles.map(commandDisplayName);
  const installed = installedFiles.length === expectedCommandFiles.length;
  const manifestTarget = manifest?.commandTargets?.[target.id];
  const upToDate = installed
    && manifest?.bundledHash === bundledHash
    && manifestTarget?.path === target.path
    && expectedCommandNames.every((name) => manifestTarget.installedCommandNames.includes(name));

  return {
    ...target,
    installed,
    upToDate,
    installedCommandNames,
  };
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonRecordIfPresent(filePath: string): JsonRecord | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isInvokerMcpServer(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  return value.type === 'stdio'
    && value.command === 'invoker-cli'
    && Array.isArray(value.args)
    && value.args.length === 1
    && value.args[0] === 'mcp';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readTomlInvokerServerBlocks(content: string, serverName: string): string[][] {
  const headerRe = new RegExp(`^\\[mcp_servers\\.${escapeRegExp(serverName)}\\]\\s*$`, 'm');
  const lines = content.split('\n');
  const blocks: string[][] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!headerRe.test(lines[i]!)) continue;
    const block: string[] = [];
    for (const line of lines.slice(i + 1)) {
      if (/^\s*\[/.test(line)) break;
      block.push(line);
    }
    blocks.push(block);
  }

  return blocks;
}

/** Crude but safe: a text scan for the TOML table and expected Invoker MCP keys, never a full parse. */
function isTomlInvokerServerRegistered(content: string, serverName: string): boolean {
  return readTomlInvokerServerBlocks(content, serverName).some((block) => {
    const hasCommand = block.some((line) => /^\s*command\s*=\s*"invoker-cli"\s*(?:#.*)?$/.test(line));
    const hasArgs = block.some((line) => /^\s*args\s*=\s*\[\s*"mcp"\s*\]\s*(?:#.*)?$/.test(line));
    return hasCommand && hasArgs;
  });
}

function isMcpTargetInstalled(target: McpTargetCandidate): boolean {
  if (!existsSync(target.path)) return false;
  if (target.format === 'toml') {
    return isTomlInvokerServerRegistered(readFileSync(target.path, 'utf-8'), target.serverName);
  }
  const config = readJsonRecordIfPresent(target.path);
  const servers = isJsonRecord(config?.mcpServers) ? config.mcpServers : undefined;
  return isInvokerMcpServer(servers?.[target.serverName]);
}

function buildMcpConfigState(
  target: McpTargetCandidate,
  bundledHash: string,
  manifest: BundledSkillsManifest | null,
): HarnessMcpConfigState {
  const installed = target.available && isMcpTargetInstalled(target);
  const manifestTarget = manifest?.mcpTargets?.[target.id];
  const upToDate = installed
    && manifest?.bundledHash === bundledHash
    && manifestTarget?.path === target.path
    && manifestTarget.serverName === target.serverName;

  const { format: _format, probeCommand: _probeCommand, ...state } = target;
  return { ...state, installed, upToDate };
}

function readMutableJsonMcpConfig(filePath: string, defaultConfig: JsonRecord): JsonRecord {
  if (!existsSync(filePath)) return { ...defaultConfig };

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    if (isJsonRecord(parsed)) return parsed;
  } catch {
    // Throw the same public error for invalid JSON and non-object JSON.
  }

  throw new Error(`Invalid MCP config at ${filePath}: expected a JSON object`);
}

/**
 * Generic JSON writer for harnesses whose MCP config is `{ mcpServers: { ... } }`
 * (OMP, Cursor, Claude Code). `defaultConfig` seeds a fresh file (OMP wants a
 * `$schema` pointer; others don't) — every other key in an existing file is
 * preserved untouched, since Claude Code's `~/.claude.json` in particular
 * carries many unrelated top-level keys this must never disturb.
 */
function installJsonMcpTarget(target: McpTargetCandidate, defaultConfig: JsonRecord): void {
  const config = readMutableJsonMcpConfig(target.path, defaultConfig);
  const existingServers = isJsonRecord(config.mcpServers) ? config.mcpServers : {};
  config.mcpServers = {
    ...existingServers,
    [target.serverName]: INVOKER_MCP_SERVER,
  };
  mkdirSync(path.dirname(target.path), { recursive: true });
  writeFileSync(target.path, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Codex stores MCP servers in `~/.codex/config.toml`, a single hand-maintained
 * file that can grow very large (project trust entries, other MCP servers).
 * Rather than parse+rewrite the whole TOML document (real corruption risk on
 * a file this sensitive), this only ever text-scans for an existing
 * `[mcp_servers.invoker]` table and, if absent, appends a new one — a pure
 * additive text operation that can't touch anything else in the file.
 */
function installTomlMcpTarget(target: McpTargetCandidate): void {
  mkdirSync(path.dirname(target.path), { recursive: true });
  const existing = existsSync(target.path) ? readFileSync(target.path, 'utf-8') : '';
  if (isTomlInvokerServerRegistered(existing, target.serverName)) return;

  const block = [
    `[mcp_servers.${target.serverName}]`,
    'command = "invoker-cli"',
    'args = ["mcp"]',
    '',
  ].join('\n');
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
  writeFileSync(target.path, existing + separator + block);
}

function installMcpTarget(target: McpTargetCandidate): void {
  if (target.format === 'toml') {
    installTomlMcpTarget(target);
    return;
  }
  const defaultConfig: JsonRecord = target.id === 'omp' ? { $schema: OMP_MCP_SCHEMA_URL } : {};
  installJsonMcpTarget(target, defaultConfig);
}

export function resolveBundledSkillsStatus(context: BundledSkillsContext): BundledSkillsStatus {
  const invokerHomeRoot = context.invokerHomeRoot ?? resolveInvokerHomeRoot();
  const isInstalled = context.isInstalled ?? commandExists;
  const sourceRoot = resolveBundledSkillsSourceRoot(context);
  if (!sourceRoot) {
    return {
      available: false,
      promptRecommended: false,
      managedPrefix: MANAGED_PREFIX,
      bundledSkillNames: [],
      targets: resolveManagedTargets(),
      commandTargets: resolveManagedCommandTargets(),
      mcpTargets: resolveManagedMcpTargets(isInstalled),
    };
  }

  const bundledSkillNames = listBundledSkillNames(sourceRoot);
  const installedNames = prefixedSkillNames(bundledSkillNames);
  const bundledHash = hashDirectory(sourceRoot);
  const manifest = readManifest(invokerHomeRoot);
  const targets = resolveManagedTargets().map((target) =>
    buildTargetStatus(target, installedNames, bundledHash, manifest),
  );
  const commandFiles = listCommandNames(sourceRoot);
  const commandTargets = resolveManagedCommandTargets().map((target) =>
    buildCommandConfigState(target, commandFiles, bundledHash, manifest),
  );
  const mcpTargets = resolveManagedMcpTargets(isInstalled).map((target) =>
    buildMcpConfigState(target, bundledHash, manifest),
  );

  return {
    available: true,
    promptRecommended: context.isPackaged && (
      targets.some((target) => !target.upToDate)
      || commandTargets.some((target) => !target.upToDate)
      || mcpTargets.some((target) => !target.upToDate)
    ),
    sourcePath: sourceRoot,
    managedPrefix: MANAGED_PREFIX,
    bundledSkillNames,
    lastInstallAt: manifest?.installedAt,
    lastInstallError: manifest?.lastInstallError,
    targets,
    commandTargets,
    mcpTargets,
  };
}

export function installBundledSkills(
  context: BundledSkillsContext,
  mode: BundledSkillsInstallMode = 'install',
): BundledSkillsStatus {
  const invokerHomeRoot = context.invokerHomeRoot ?? resolveInvokerHomeRoot();
  const isInstalled = context.isInstalled ?? commandExists;
  const sourceRoot = resolveBundledSkillsSourceRoot(context);
  if (!sourceRoot) {
    throw new Error('Bundled skills are not available in this app build.');
  }

  const bundledSkillNames = listBundledSkillNames(sourceRoot);
  for (const skillName of bundledSkillNames) {
    assertSkillSourceValid(path.join(sourceRoot, skillName), skillName);
  }
  const bundledHash = hashDirectory(sourceRoot);
  const installedNames = prefixedSkillNames(bundledSkillNames);
  const targets = resolveManagedTargets();
  const commandTargets = resolveManagedCommandTargets();
  const mcpTargets = resolveManagedMcpTargets(isInstalled);
  const manifestTargets: BundledSkillsManifest['targets'] = {};
  const manifestCommandTargets: NonNullable<BundledSkillsManifest['commandTargets']> = {};
  const manifestMcpTargets: NonNullable<BundledSkillsManifest['mcpTargets']> = {};

  for (const target of targets) {
    mkdirSync(target.path, { recursive: true });
    for (const skillName of bundledSkillNames) {
      const sourceDir = path.join(sourceRoot, skillName);
      const targetDir = path.join(target.path, managedSkillName(skillName));
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true, force: true });
    }
    manifestTargets[target.id] = {
      path: target.path,
      installedSkillNames: installedNames,
    };
  }

  const commandSourceRoot = commandSourceDir(sourceRoot);
  const commandFiles = listCommandNames(sourceRoot);
  for (const target of commandTargets) {
    mkdirSync(target.path, { recursive: true });
    for (const fileName of commandFiles) {
      copyFileSync(path.join(commandSourceRoot, fileName), path.join(target.path, fileName));
    }
    manifestCommandTargets[target.id] = {
      path: target.path,
      installedCommandNames: commandFiles.map(commandDisplayName),
    };
  }

  for (const target of mcpTargets) {
    if (!target.available) continue;
    installMcpTarget(target);
    manifestMcpTargets[target.id] = {
      path: target.path,
      serverName: target.serverName,
    };
  }

  const manifest: BundledSkillsManifest = {
    bundledHash,
    bundledSkillNames,
    installedAt: new Date().toISOString(),
    targets: manifestTargets,
    commandTargets: manifestCommandTargets,
    mcpTargets: manifestMcpTargets,
  };

  writeManifest(invokerHomeRoot, manifest);

  const status = resolveBundledSkillsStatus(context);
  return {
    ...status,
    promptRecommended: context.isPackaged && mode === 'install' ? false : status.promptRecommended,
  };
}

export function resolveInstalledBundledSkillDir(skillName: string): string {
  return path.join(homedir(), '.codex', 'skills', managedSkillName(skillName));
}
