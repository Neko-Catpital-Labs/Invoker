/**

* Manages the installation lifecycle of Invoker-bundled skills and harness integrations.
*
* Installs, inspects, and uninstalls bundled skills and commands in Invoker home,
* with optional integration setup for supported harnesses, including MCP server
* entries, Cursor rules, and always-on instructions for Codex and Claude.
*
* Tracks ownership of installed artifacts through manifests, fingerprints, and
* ownership markers to identify what Invoker manages. Uninstallation removes
* owned artifacts selectively, preserving unrelated user configuration and data.
*/
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { resolveInvokerHomeRoot, type IsInstalled } from '@invoker/contracts';
import type {
  HarnessConfigState,
  HarnessInstructionConfigState,
  HarnessMcpConfigState,
  BundledSkillsInstallMode,
  BundledSkillsStatus,
  BundledSkillTargetStatus,
} from '@invoker/contracts';

import { commandExists } from './command-exists.js';
import { CLAUDE_HOOK_SCRIPT, CURSOR_RULE_CONTENTS, EXECUTION_ROUTING_FRAGMENT } from './always-on/fragments.js';

const MANAGED_PREFIX = 'invoker-';
const MANIFEST_FILE = 'bundled-skills.json';
const OMP_MCP_SCHEMA_URL = 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json';
const INVOKER_MCP_SERVER = { type: 'stdio', command: 'invoker-cli', args: ['mcp'] } as const;
const INVOKER_MCP_SERVER_NAME = 'invoker';
const INSTRUCTION_BEGIN = '<!-- invoker-execution -->';
const INSTRUCTION_END = '<!-- /invoker-execution -->';
const CURSOR_RULE_FILE = 'invoker-execution-precedence.mdc';
const CLAUDE_HOOK_MARKER = 'invoker-execution/claude_prompt_submit';
const INSTRUCTION_NAME = 'invoker-execution';
const INSTALL_ERROR_JOIN = '; ';
const INVOKER_SKILLS_DIR = 'skills';
const INVOKER_COMMANDS_DIR = 'commands';
const INVOKER_MCP_SNIPPET_RELATIVE = path.join('mcp-servers', 'invoker.json');
export const HARNESS_REGISTRATION_HINT =
  'Harness MCP/skills stay opt-in. Re-run setup and answer yes, or pass --register-harnesses.';

interface BundledSkillsManifest {
  bundledHash: string;
  bundledSkillNames: string[];
  installedAt: string;
  lastInstallError?: string;
  harnessesRegistered?: boolean;
  targets: Record<string, { path: string; installedSkillNames: string[] }>;
  commandTargets?: Record<string, { path: string; installedCommandNames: string[] }>;
  mcpTargets?: Record<string, { path: string; serverName: string }>;
  instructionTargets?: Record<string, { path: string; installedInstructionNames: string[] }>;
  instructionHash?: string;
  /**
   * The Invoker source checkout these skills were bundled from (unset for
   * packaged Electron builds, whose resources dir isn't a real checkout).
   * Read by installed doctor scripts (e.g. skills/plan-to-invoker/scripts/
   * validate-plan.sh, lint-review-units.mjs) as a last-resort fallback when
   * they're running from a machine-level skill install outside any git repo
   * and can't resolve their own Invoker checkout via git.
   */
  sourceRepoRoot?: string;
  yamlModuleRoot?: string;
}

interface BundledSkillsContext {
  isPackaged: boolean;
  repoRoot: string;
  resourcesPath?: string;
  invokerHomeRoot?: string;
  /** Injectable for tests; defaults to real `command -v` probing. */
  isInstalled?: IsInstalled;
}

export interface InstallBundledSkillsOptions {
  /** When true, write MCP/skills/commands/always-on into detected harnesses. Default false (no skill materialization). */
  registerHarnesses?: boolean;
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

  const repoSkillRoots = [
    path.join(context.repoRoot, 'corpus', 'skills'),
    path.join(context.repoRoot, 'skills'),
  ];
  return repoSkillRoots.find((repoSkills) => existsSync(repoSkills)) ?? null;
}

export type BundledSkillCategory = 'all' | 'core' | 'optimization';

function readBundledSkillCategory(sourceDir: string): string | null {
  const lines = readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8').split('\n');
  if (lines[0]?.trim() !== '---') return null;
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (trimmed === '---') return null;
    const match = /^category:\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const value = match[1].trim().replace(/^['"]|['"]$/g, '').trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export function listBundledSkillNames(sourceRoot: string, category: BundledSkillCategory = 'all'): string[] {
  const names = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(sourceRoot, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  if (category === 'all') return names;
  return names.filter((name) => readBundledSkillCategory(path.join(sourceRoot, name)) === category);
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

function resolveInvokerSkillTarget(invokerHomeRoot: string): BundledSkillTargetStatus {
  return {
    id: 'invoker',
    name: 'Invoker',
    path: path.join(invokerHomeRoot, INVOKER_SKILLS_DIR),
    available: true,
    installed: false,
    upToDate: false,
    installedSkillNames: [],
  };
}

function resolveManagedTargets(invokerHomeRoot: string): BundledSkillTargetStatus[] {
  return [resolveInvokerSkillTarget(invokerHomeRoot)];
}

function resolveManagedCommandTargets(invokerHomeRoot: string): HarnessConfigState[] {
  return [
    {
      id: 'invoker',
      name: 'Invoker',
      path: path.join(invokerHomeRoot, INVOKER_COMMANDS_DIR),
      available: true,
      installed: false,
      upToDate: false,
      installedCommandNames: [],
    },
  ];
}

function resolveHarnessSkillTargets(): BundledSkillTargetStatus[] {
  return [
    {
      id: 'codex',
      name: 'Codex',
      path: path.join(homedir(), '.codex', 'skills'),
      available: true,
      installed: false,
      upToDate: false,
      installedSkillNames: [],
    },
    {
      id: 'claude',
      name: 'Claude',
      path: path.join(homedir(), '.claude', 'skills'),
      available: true,
      installed: false,
      upToDate: false,
      installedSkillNames: [],
    },
    {
      id: 'cursor',
      name: 'Cursor',
      path: path.join(homedir(), '.cursor', 'skills'),
      available: true,
      installed: false,
      upToDate: false,
      installedSkillNames: [],
    },
    {
      id: 'omp',
      name: 'OMP',
      path: path.join(homedir(), '.omp', 'agent', 'skills'),
      available: true,
      installed: false,
      upToDate: false,
      installedSkillNames: [],
    },
  ];
}

function resolveHarnessCommandTargets(): HarnessConfigState[] {
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

function syncSkillTargets(params: {
  targets: BundledSkillTargetStatus[];
  sourceRoot: string;
  bundledSkillNames: string[];
  installedNames: string[];
  currentBundledSkillNames: Set<string>;
  previousManifest: BundledSkillsManifest | null;
  manifestTargets: BundledSkillsManifest['targets'];
}): void {
  const {
    targets,
    sourceRoot,
    bundledSkillNames,
    installedNames,
    currentBundledSkillNames,
    previousManifest,
    manifestTargets,
  } = params;
  for (const target of targets) {
    mkdirSync(target.path, { recursive: true });
    const previouslyInstalledNames = previousManifest?.targets?.[target.id]?.installedSkillNames ?? [];
    const droppedSkillNames = previouslyInstalledNames.filter((name) =>
      name.startsWith(MANAGED_PREFIX) && !currentBundledSkillNames.has(name),
    );
    removeManagedSkillDirs(target.path, droppedSkillNames);
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
}

function syncCommandTargets(params: {
  targets: HarnessConfigState[];
  sourceRoot: string;
  commandFiles: string[];
  previousManifest: BundledSkillsManifest | null;
  manifestCommandTargets: NonNullable<BundledSkillsManifest['commandTargets']>;
}): void {
  const { targets, sourceRoot, commandFiles, previousManifest, manifestCommandTargets } = params;
  const commandSourceRoot = commandSourceDir(sourceRoot);
  const currentCommandNames = new Set(commandFiles.map(commandDisplayName));
  for (const target of targets) {
    mkdirSync(target.path, { recursive: true });
    const previouslyInstalledNames = previousManifest?.commandTargets?.[target.id]?.installedCommandNames ?? [];
    const droppedCommandFiles = previouslyInstalledNames
      .filter((name) => name.startsWith(MANAGED_PREFIX) && !currentCommandNames.has(name))
      .map((name) => name.endsWith('.md') ? name : `${name}.md`);
    removeManagedCommandFiles(target.path, droppedCommandFiles);
    for (const fileName of commandFiles) {
      copyFileSync(path.join(commandSourceRoot, fileName), path.join(target.path, fileName));
    }
    manifestCommandTargets[target.id] = {
      path: target.path,
      installedCommandNames: commandFiles.map(commandDisplayName),
    };
  }
}

function resolveInvokerMcpSnippetPath(invokerHomeRoot: string): string {
  return path.join(invokerHomeRoot, INVOKER_MCP_SNIPPET_RELATIVE);
}

function removeInvokerMcpSnippet(invokerHomeRoot: string): void {
  rmSync(resolveInvokerMcpSnippetPath(invokerHomeRoot), { force: true });
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

function resolveYamlModuleRoot(context: BundledSkillsContext): string | undefined {
  const roots: string[] = [];
  if (context.isPackaged) {
    const resourceRoot = context.resourcesPath ?? electronResourcesPath();
    if (resourceRoot) {
      let dir = resourceRoot;
      for (let depth = 0; depth < 6; depth += 1) {
        dir = path.dirname(dir);
        roots.push(dir);
      }
    }
  } else {
    roots.push(path.join(context.repoRoot, 'packages', 'app'));
    roots.push(context.repoRoot);
  }
  for (const root of roots) {
    if (existsSync(path.join(root, 'node_modules', 'yaml', 'dist', 'index.js'))) return root;
  }
  return undefined;
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

function readTextFileIfPresent(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf-8');
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

function findTomlInvokerServerBlockRange(content: string, serverName: string): { start: number; end: number } | null {
  const headerRe = new RegExp(`^\\[mcp_servers\\.${escapeRegExp(serverName)}\\]\\s*$`, 'm');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!headerRe.test(lines[i]!)) continue;
    let end = i + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end += 1;
    return { start: i, end };
  }
  return null;
}

function isMcpTargetInstalled(target: McpTargetCandidate): boolean {
  if (target.format === 'toml') {
    const content = readTextFileIfPresent(target.path);
    if (content === null) return false;
    return isTomlInvokerServerRegistered(content, target.serverName);
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

function writeFileAtomic(filePath: string, content: string): void {
  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600;
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, content, { mode });
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, filePath);
  } finally {
    rmSync(tmpPath, { force: true });
  }
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
  writeFileAtomic(target.path, `${JSON.stringify(config, null, 2)}\n`);
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

  const blockLines = [
    `[mcp_servers.${target.serverName}]`,
    'command = "invoker-cli"',
    'args = ["mcp"]',
  ];

  const staleRange = findTomlInvokerServerBlockRange(existing, target.serverName);
  if (staleRange) {
    const lines = existing.split('\n');
    const replaced = [...lines.slice(0, staleRange.start), ...blockLines, '', ...lines.slice(staleRange.end)];
    writeFileAtomic(target.path, replaced.join('\n'));
    return;
  }

  const block = [...blockLines, ''].join('\n');
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
  writeFileAtomic(target.path, existing + separator + block);
}

function installMcpTarget(target: McpTargetCandidate): void {
  if (target.format === 'toml') {
    installTomlMcpTarget(target);
    return;
  }
  const defaultConfig: JsonRecord = target.id === 'omp' ? { $schema: OMP_MCP_SCHEMA_URL } : {};
  installJsonMcpTarget(target, defaultConfig);
}

function caughtMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinInstallErrors(errors: string[]): string | undefined {
  if (errors.length === 0) return undefined;
  return errors.join(INSTALL_ERROR_JOIN);
}

function installAvailableMcpTargets(
  mcpTargets: McpTargetCandidate[],
): { recorded: NonNullable<BundledSkillsManifest['mcpTargets']>; errors: string[] } {
  const recorded: NonNullable<BundledSkillsManifest['mcpTargets']> = {};
  const errors: string[] = [];
  for (const target of mcpTargets) {
    if (!target.available) continue;
    try {
      installMcpTarget(target);
      recorded[target.id] = { path: target.path, serverName: target.serverName };
    } catch (error) {
      errors.push(caughtMessage(error));
    }
  }
  return { recorded, errors };
}

function uninstallJsonMcpTarget(target: McpTargetCandidate): void {
  if (!existsSync(target.path)) return;
  const config = readMutableJsonMcpConfig(target.path, {});
  if (!isJsonRecord(config.mcpServers) || !(target.serverName in config.mcpServers)) return;
  const { [target.serverName]: _removed, ...rest } = config.mcpServers;
  config.mcpServers = rest;
  writeFileAtomic(target.path, `${JSON.stringify(config, null, 2)}\n`);
}

function uninstallTomlMcpTarget(target: McpTargetCandidate): void {
  if (!existsSync(target.path)) return;
  const existing = readFileSync(target.path, 'utf-8');
  const range = findTomlInvokerServerBlockRange(existing, target.serverName);
  if (!range) return;
  const lines = existing.split('\n');
  const next = [...lines.slice(0, range.start), ...lines.slice(range.end)].join('\n').replace(/\n{3,}/g, '\n\n');
  writeFileAtomic(target.path, next.endsWith('\n') ? next : `${next}\n`);
}

function uninstallMcpTarget(target: McpTargetCandidate): void {
  if (target.format === 'toml') {
    uninstallTomlMcpTarget(target);
    return;
  }
  uninstallJsonMcpTarget(target);
}

function hashAlwaysOnFragments(): string {
  const hash = createHash('sha256');
  hash.update(CURSOR_RULE_CONTENTS);
  hash.update('\0');
  hash.update(EXECUTION_ROUTING_FRAGMENT);
  hash.update('\0');
  hash.update(CLAUDE_HOOK_SCRIPT);
  return hash.digest('hex');
}

function resolveCursorRulePath(): string {
  return path.join(homedir(), '.cursor', 'rules', CURSOR_RULE_FILE);
}

function resolveCodexAgentsPath(): string {
  return path.join(homedir(), '.codex', 'AGENTS.md');
}

function resolveClaudeSettingsPath(): string {
  return path.join(homedir(), '.claude', 'settings.json');
}

function resolveLegacyCursorSkillsPath(): string {
  return path.join(homedir(), '.cursor', 'skills-cursor');
}

function resolveHookInstallDir(invokerHomeRoot: string): string {
  return path.join(invokerHomeRoot, 'hooks', 'invoker-execution');
}

function assertNotSymlink(filePath: string): void {
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing to write through symlink: ${filePath}`);
  }
}

function wrapInstructionFragment(fragment: string): string {
  return `${INSTRUCTION_BEGIN}\n${fragment.trim()}\n${INSTRUCTION_END}\n`;
}

function mergeMarkedBlock(existing: string, fragment: string): string {
  const block = wrapInstructionFragment(fragment);
  if (existing.includes(INSTRUCTION_BEGIN)) {
    const start = existing.indexOf(INSTRUCTION_BEGIN);
    let end = existing.indexOf(INSTRUCTION_END, start);
    if (end === -1) return `${existing.slice(0, start)}${block}`;
    end += INSTRUCTION_END.length;
    if (existing[end] === '\n') end += 1;
    return `${existing.slice(0, start)}${block}${existing.slice(end)}`;
  }
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  const extra = existing ? '\n' : '';
  return `${existing}${sep}${extra}${block}`;
}

function removeMarkedBlock(existing: string): string {
  const start = existing.indexOf(INSTRUCTION_BEGIN);
  if (start === -1) return existing;
  let end = existing.indexOf(INSTRUCTION_END, start);
  if (end === -1) return existing.slice(0, start);
  end += INSTRUCTION_END.length;
  if (existing[end] === '\n') end += 1;
  return `${existing.slice(0, start)}${existing.slice(end)}`.replace(/\n{3,}/g, '\n\n');
}

function isClaudeHookEntry(entry: unknown): boolean {
  if (!isJsonRecord(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((hook) => isJsonRecord(hook) && typeof hook.command === 'string' && hook.command.includes(CLAUDE_HOOK_MARKER));
}

function installCursorRule(): string {
  const rulePath = resolveCursorRulePath();
  assertNotSymlink(rulePath);
  mkdirSync(path.dirname(rulePath), { recursive: true });
  writeFileSync(rulePath, CURSOR_RULE_CONTENTS);
  return rulePath;
}

function installCodexAgentsBlock(): string {
  const agentsPath = resolveCodexAgentsPath();
  assertNotSymlink(agentsPath);
  mkdirSync(path.dirname(agentsPath), { recursive: true });
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  writeFileAtomic(agentsPath, mergeMarkedBlock(existing, EXECUTION_ROUTING_FRAGMENT));
  return agentsPath;
}

function installClaudeHook(invokerHomeRoot: string): string {
  const hookDir = resolveHookInstallDir(invokerHomeRoot);
  mkdirSync(hookDir, { recursive: true });
  const destScript = path.join(hookDir, 'claude_prompt_submit.mjs');
  writeFileSync(destScript, CLAUDE_HOOK_SCRIPT);
  chmodSync(destScript, 0o755);

  const settingsPath = resolveClaudeSettingsPath();
  assertNotSymlink(settingsPath);
  let settings: JsonRecord = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as unknown;
      if (!isJsonRecord(parsed)) throw new Error('not object');
      settings = parsed;
    } catch {
      throw new Error(`Invalid Claude settings at ${settingsPath}: expected a JSON object`);
    }
  }
  const hooksRoot = isJsonRecord(settings.hooks) ? settings.hooks : {};
  const existingEntries = Array.isArray(hooksRoot.UserPromptSubmit) ? hooksRoot.UserPromptSubmit : [];
  const kept = existingEntries.filter((entry) => !isClaudeHookEntry(entry));
  kept.push({
    hooks: [
      {
        type: 'command',
        command: `node ${destScript}`,
        timeout: 10,
      },
    ],
  });
  settings.hooks = { ...hooksRoot, UserPromptSubmit: kept };
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}

function uninstallCursorRule(): void {
  const rulePath = resolveCursorRulePath();
  if (!existsSync(rulePath)) return;
  if (lstatSync(rulePath).isSymbolicLink()) return;
  rmSync(rulePath);
}

function uninstallCodexAgentsBlock(): void {
  const agentsPath = resolveCodexAgentsPath();
  if (!existsSync(agentsPath) || lstatSync(agentsPath).isSymbolicLink()) return;
  const next = removeMarkedBlock(readFileSync(agentsPath, 'utf8')).trim();
  if (!next) {
    rmSync(agentsPath);
    return;
  }
  writeFileAtomic(agentsPath, `${next}\n`);
}

function uninstallClaudeHook(invokerHomeRoot: string): void {
  const settingsPath = resolveClaudeSettingsPath();
  if (existsSync(settingsPath) && !lstatSync(settingsPath).isSymbolicLink()) {
    let settings: JsonRecord;
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as unknown;
      if (!isJsonRecord(parsed)) throw new Error('not object');
      settings = parsed;
    } catch {
      throw new Error(`Invalid Claude settings at ${settingsPath}: expected a JSON object`);
    }
    if (isJsonRecord(settings.hooks) && Array.isArray(settings.hooks.UserPromptSubmit)) {
      settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter((entry) => !isClaudeHookEntry(entry));
      writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
  }
  rmSync(resolveHookInstallDir(invokerHomeRoot), { recursive: true, force: true });
}

function cursorRuleInstalled(): boolean {
  const content = readTextFileIfPresent(resolveCursorRulePath());
  return content !== null && content.includes('Invoker execution routing');
}

function codexAgentsInstalled(): boolean {
  const content = readTextFileIfPresent(resolveCodexAgentsPath());
  return content !== null && content.includes(INSTRUCTION_BEGIN);
}

function claudeHookInstalled(): boolean {
  const settingsPath = resolveClaudeSettingsPath();
  if (!existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
    if (!isJsonRecord(settings) || !isJsonRecord(settings.hooks) || !Array.isArray(settings.hooks.UserPromptSubmit)) return false;
    return settings.hooks.UserPromptSubmit.some((entry) => isClaudeHookEntry(entry));
  } catch {
    return false;
  }
}

function resolveInstructionTargets(): HarnessInstructionConfigState[] {
  return [
    {
      id: 'cursor',
      name: 'Cursor',
      path: resolveCursorRulePath(),
      available: true,
      installed: false,
      upToDate: false,
      installedInstructionNames: [],
    },
    {
      id: 'codex',
      name: 'Codex',
      path: resolveCodexAgentsPath(),
      available: true,
      installed: false,
      upToDate: false,
      installedInstructionNames: [],
    },
    {
      id: 'claude',
      name: 'Claude',
      path: resolveClaudeSettingsPath(),
      available: true,
      installed: false,
      upToDate: false,
      installedInstructionNames: [],
    },
  ].map((target) => {
    const installed = target.id === 'cursor'
      ? cursorRuleInstalled()
      : target.id === 'codex'
        ? codexAgentsInstalled()
        : claudeHookInstalled();
    return { ...target, installed, installedInstructionNames: installed ? [INSTRUCTION_NAME] : [] };
  });
}

function buildInstructionTargetStatus(
  target: HarnessInstructionConfigState,
  instructionHash: string,
  manifest: BundledSkillsManifest | null,
): HarnessInstructionConfigState {
  const manifestTarget = manifest?.instructionTargets?.[target.id];
  const upToDate = target.installed
    && manifest?.instructionHash === instructionHash
    && manifestTarget?.path === target.path
    && (manifestTarget.installedInstructionNames ?? []).includes(INSTRUCTION_NAME);
  return { ...target, upToDate };
}

function recordInstructionInstall(
  install: () => string,
  errors: string[],
): { path: string; installedInstructionNames: string[] } | undefined {
  try {
    return { path: install(), installedInstructionNames: [INSTRUCTION_NAME] };
  } catch (error) {
    errors.push(caughtMessage(error));
    return undefined;
  }
}

function installInstructionTargets(
  invokerHomeRoot: string,
  errors: string[],
): BundledSkillsManifest['instructionTargets'] {
  const recorded: NonNullable<BundledSkillsManifest['instructionTargets']> = {};
  const cursor = recordInstructionInstall(installCursorRule, errors);
  const codex = recordInstructionInstall(installCodexAgentsBlock, errors);
  const claude = recordInstructionInstall(() => installClaudeHook(invokerHomeRoot), errors);
  if (cursor) recorded.cursor = cursor;
  if (codex) recorded.codex = codex;
  if (claude) recorded.claude = claude;
  return recorded;
}

function removeManagedSkillDirs(targetPath: string, names: string[]): void {
  if (!existsSync(targetPath)) return;
  for (const name of names) {
    rmSync(path.join(targetPath, name), { recursive: true, force: true });
  }
}

function removeManagedCommandFiles(targetPath: string, fileNames: string[]): void {
  if (!existsSync(targetPath)) return;
  for (const fileName of fileNames) {
    const filePath = path.join(targetPath, fileName);
    if (existsSync(filePath) && !lstatSync(filePath).isSymbolicLink()) rmSync(filePath);
  }
}

function previousHarnessesRegistered(
  manifest: BundledSkillsManifest | null,
  invokerHomeRoot: string,
): boolean {
  if (!manifest) return false;
  if (manifest.harnessesRegistered === true) return true;
  if (manifest.mcpTargets && Object.keys(manifest.mcpTargets).length > 0) return true;
  if (manifest.instructionTargets && Object.keys(manifest.instructionTargets).length > 0) return true;
  const keepSkillPath = path.join(invokerHomeRoot, INVOKER_SKILLS_DIR);
  for (const entry of Object.values(manifest.targets ?? {})) {
    if (entry.path !== keepSkillPath) return true;
  }
  const keepCommandPath = path.join(invokerHomeRoot, INVOKER_COMMANDS_DIR);
  for (const entry of Object.values(manifest.commandTargets ?? {})) {
    if (entry.path !== keepCommandPath) return true;
  }
  return false;
}

export function resolveBundledSkillsStatus(context: BundledSkillsContext): BundledSkillsStatus {
  const invokerHomeRoot = context.invokerHomeRoot ?? resolveInvokerHomeRoot();
  const isInstalled = context.isInstalled ?? commandExists;
  const sourceRoot = resolveBundledSkillsSourceRoot(context);
  const instructionHash = hashAlwaysOnFragments();
  const manifest = readManifest(invokerHomeRoot);
  const instructionTargets = resolveInstructionTargets().map((target) =>
    buildInstructionTargetStatus(target, instructionHash, manifest),
  );
  if (!sourceRoot) {
    return {
      available: false,
      promptRecommended: false,
      managedPrefix: MANAGED_PREFIX,
      bundledSkillNames: [],
      harnessesRegistered: previousHarnessesRegistered(manifest, invokerHomeRoot),
      targets: resolveHarnessSkillTargets(),
      commandTargets: resolveHarnessCommandTargets(),
      mcpTargets: resolveManagedMcpTargets(isInstalled),
      instructionTargets,
    };
  }

  const bundledSkillNames = listBundledSkillNames(sourceRoot);
  const installedNames = prefixedSkillNames(bundledSkillNames);
  const bundledHash = hashDirectory(sourceRoot);
  const targets = resolveHarnessSkillTargets().map((target) =>
    buildTargetStatus(target, installedNames, bundledHash, manifest),
  );
  const commandFiles = listCommandNames(sourceRoot);
  const commandTargets = resolveHarnessCommandTargets().map((target) =>
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
    ),
    sourcePath: sourceRoot,
    managedPrefix: MANAGED_PREFIX,
    bundledSkillNames,
    lastInstallAt: manifest?.installedAt,
    lastInstallError: manifest?.lastInstallError,
    harnessesRegistered: previousHarnessesRegistered(manifest, invokerHomeRoot),
    targets,
    commandTargets,
    mcpTargets,
    instructionTargets,
  };
}

export function installBundledSkills(
  context: BundledSkillsContext,
  mode: BundledSkillsInstallMode = 'install',
  category: BundledSkillCategory = 'all',
  options: InstallBundledSkillsOptions = {},
): BundledSkillsStatus {
  const invokerHomeRoot = context.invokerHomeRoot ?? resolveInvokerHomeRoot();
  const isInstalled = context.isInstalled ?? commandExists;
  if (mode === 'uninstall') {
    return uninstallBundledSkills(context, category);
  }
  const sourceRoot = resolveBundledSkillsSourceRoot(context);
  if (!sourceRoot) {
    throw new Error('Bundled skills are not available in this app build.');
  }

  const previousManifest = readManifest(invokerHomeRoot);
  const registerHarnesses =
    options.registerHarnesses === true || previousHarnessesRegistered(previousManifest, invokerHomeRoot);

  removeLeftoverHomeSkillArtifacts(invokerHomeRoot);
  removeInvokerMcpSnippet(invokerHomeRoot);

  if (!registerHarnesses) {
    const status = resolveBundledSkillsStatus(context);
    return {
      ...status,
      harnessesRegistered: false,
    };
  }

  const bundledSkillNames = listBundledSkillNames(sourceRoot, category);
  for (const skillName of bundledSkillNames) {
    assertSkillSourceValid(path.join(sourceRoot, skillName), skillName);
  }
  const bundledHash = hashDirectory(sourceRoot);
  const installedNames = prefixedSkillNames(bundledSkillNames);
  const currentBundledSkillNames = new Set(prefixedSkillNames(listBundledSkillNames(sourceRoot, 'all')));
  const commandFiles = listCommandNames(sourceRoot);
  const manifestTargets: BundledSkillsManifest['targets'] = {};
  const manifestCommandTargets: NonNullable<BundledSkillsManifest['commandTargets']> = {};

  const cleanupErrors = removeLegacyHarnessCopies(
    previousManifest,
    invokerHomeRoot,
    [...currentBundledSkillNames],
    commandFiles,
    isInstalled,
    { preserveHarnessRegistrations: true },
  );

  const skillSync = {
    sourceRoot,
    bundledSkillNames,
    installedNames,
    currentBundledSkillNames,
    previousManifest,
    manifestTargets,
  };
  syncSkillTargets({ ...skillSync, targets: resolveHarnessSkillTargets() });
  syncCommandTargets({
    targets: resolveHarnessCommandTargets(),
    sourceRoot,
    commandFiles,
    previousManifest,
    manifestCommandTargets,
  });
  const mcpInstall = installAvailableMcpTargets(resolveManagedMcpTargets(isInstalled));
  const instructionErrors: string[] = [];
  const instructionRecorded = installInstructionTargets(invokerHomeRoot, instructionErrors) ?? {};
  const lastInstallError = joinInstallErrors([
    ...cleanupErrors,
    ...mcpInstall.errors,
    ...instructionErrors,
  ]);
  const instructionHash = hashAlwaysOnFragments();

  const manifest: BundledSkillsManifest = {
    bundledHash,
    bundledSkillNames,
    installedAt: new Date().toISOString(),
    lastInstallError,
    harnessesRegistered: true,
    targets: manifestTargets,
    commandTargets: manifestCommandTargets,
    mcpTargets: mcpInstall.recorded,
    instructionTargets: instructionRecorded,
    instructionHash,
    sourceRepoRoot: context.isPackaged ? undefined : context.repoRoot,
    yamlModuleRoot: resolveYamlModuleRoot(context),
  };

  writeManifest(invokerHomeRoot, manifest);

  const status = resolveBundledSkillsStatus(context);
  return {
    ...status,
    harnessesRegistered: true,
  };
}

function removeLeftoverHomeSkillArtifacts(invokerHomeRoot: string): void {
  rmSync(path.join(invokerHomeRoot, INVOKER_SKILLS_DIR), { recursive: true, force: true });
  rmSync(path.join(invokerHomeRoot, INVOKER_COMMANDS_DIR), { recursive: true, force: true });
}

function removeLegacyHarnessCopies(
  previousManifest: BundledSkillsManifest | null,
  invokerHomeRoot: string,
  managedSkillNames: string[],
  commandFiles: string[],
  isInstalled: IsInstalled,
  options: { preserveHarnessRegistrations?: boolean } = {},
): string[] {
  const errors: string[] = [];
  if (!previousManifest) return errors;
  const preserveHarnessRegistrations = options.preserveHarnessRegistrations === true;
  const keepSkillPath = path.join(invokerHomeRoot, INVOKER_SKILLS_DIR);
  const keepCommandPath = path.join(invokerHomeRoot, INVOKER_COMMANDS_DIR);

  if (!preserveHarnessRegistrations) {
    for (const entry of Object.values(previousManifest.targets ?? {})) {
      if (entry.path === keepSkillPath) continue;
      removeManagedSkillDirs(entry.path, entry.installedSkillNames.length > 0 ? entry.installedSkillNames : managedSkillNames);
    }
  }
  removeManagedSkillDirs(
    resolveLegacyCursorSkillsPath(),
    managedSkillNames.length > 0 ? managedSkillNames : managedNamesFromManifestOrPrefix(previousManifest, resolveLegacyCursorSkillsPath()),
  );

  if (!preserveHarnessRegistrations) {
    for (const entry of Object.values(previousManifest.commandTargets ?? {})) {
      if (entry.path === keepCommandPath) continue;
      const files = entry.installedCommandNames.map((name) => name.endsWith('.md') ? name : `${name}.md`);
      removeManagedCommandFiles(entry.path, files.length > 0 ? files : commandFiles);
    }

    for (const recorded of Object.values(previousManifest.mcpTargets ?? {})) {
      const target = resolveManagedMcpTargets(isInstalled).find((candidate) => candidate.path === recorded.path);
      if (!target) continue;
      try {
        uninstallMcpTarget(target);
      } catch {
        continue;
      }
    }

    if (previousManifest.instructionTargets && Object.keys(previousManifest.instructionTargets).length > 0) {
      try {
        uninstallCursorRule();
        uninstallCodexAgentsBlock();
        uninstallClaudeHook(invokerHomeRoot);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return errors;
}

function managedNamesFromManifestOrPrefix(manifest: BundledSkillsManifest | null, targetPath: string): string[] {
  const recorded = manifest?.targets
    ? Object.values(manifest.targets).find((entry) => entry.path === targetPath)?.installedSkillNames
    : undefined;
  if (recorded && recorded.length > 0) return recorded;
  if (!existsSync(targetPath)) return [];
  return readdirSync(targetPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(MANAGED_PREFIX))
    .map((entry) => entry.name);
}

function managedCommandFilesFromManifestOrPrefix(manifest: BundledSkillsManifest | null, targetPath: string): string[] {
  const recorded = manifest?.commandTargets
    ? Object.values(manifest.commandTargets).find((entry) => entry.path === targetPath)?.installedCommandNames
    : undefined;
  if (recorded && recorded.length > 0) return recorded.map((name) => name.endsWith('.md') ? name : `${name}.md`);
  if (!existsSync(targetPath)) return [];
  return readdirSync(targetPath).filter((name) => name.startsWith(MANAGED_PREFIX) && name.endsWith('.md'));
}

function uninstallBundledSkills(
  context: BundledSkillsContext,
  category: BundledSkillCategory = 'all',
): BundledSkillsStatus {
  const invokerHomeRoot = context.invokerHomeRoot ?? resolveInvokerHomeRoot();
  const isInstalled = context.isInstalled ?? commandExists;
  const manifest = readManifest(invokerHomeRoot);
  const sourceRoot = resolveBundledSkillsSourceRoot(context);
  const expectedNames = sourceRoot ? prefixedSkillNames(listBundledSkillNames(sourceRoot, category)) : [];
  const commandFiles = sourceRoot ? listCommandNames(sourceRoot) : [];

  removeLegacyHarnessCopies(manifest, invokerHomeRoot, expectedNames, commandFiles, isInstalled);

  for (const target of [...resolveManagedTargets(invokerHomeRoot), ...resolveHarnessSkillTargets()]) {
    const names = managedNamesFromManifestOrPrefix(manifest, target.path);
    removeManagedSkillDirs(target.path, names.length > 0 ? names : expectedNames);
  }

  for (const target of [...resolveManagedCommandTargets(invokerHomeRoot), ...resolveHarnessCommandTargets()]) {
    const files = managedCommandFilesFromManifestOrPrefix(manifest, target.path);
    removeManagedCommandFiles(target.path, files.length > 0 ? files : commandFiles);
  }

  removeLeftoverHomeSkillArtifacts(invokerHomeRoot);
  removeInvokerMcpSnippet(invokerHomeRoot);
  rmSync(resolveManifestPath(invokerHomeRoot), { force: true });

  return resolveBundledSkillsStatus(context);
}

export function resolveInstalledBundledSkillDir(skillName: string, invokerHomeRoot?: string): string {
  return path.join(invokerHomeRoot ?? resolveInvokerHomeRoot(), INVOKER_SKILLS_DIR, managedSkillName(skillName));
}

export type BundledOwnedResourceKind = 'dedicated_file' | 'dedicated_dir' | 'shared_entry';

export type BundledOwnedExecutePhase = 'shared' | 'dedicated' | 'home';

export interface BundledOwnedResource {
  id: string;
  kind: BundledOwnedResourceKind;
  path: string;
  detail: string;
  present: boolean;
  userModified: boolean;
  executePhase: BundledOwnedExecutePhase;
}

const STATUS_REMOVED = 'removed';
const STATUS_KEPT_USER_MODIFIED = 'kept (user-modified)';
const STATUS_ABSENT = 'absent';

export type BundledOwnedRemovalStatus =
  | typeof STATUS_REMOVED
  | typeof STATUS_KEPT_USER_MODIFIED
  | typeof STATUS_ABSENT;

function directoriesMatch(leftPath: string, rightPath: string): boolean {
  if (!existsSync(leftPath) || !existsSync(rightPath)) return false;
  return hashDirectory(leftPath) === hashDirectory(rightPath);
}

function fileMatchesExpected(filePath: string, expected: string): boolean {
  if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink()) return false;
  return readFileSync(filePath, 'utf8') === expected;
}

function pushOwned(
  out: BundledOwnedResource[],
  resource: BundledOwnedResource,
): void {
  if (!resource.present && !resource.userModified) return;
  out.push(resource);
}

function discoverMcpOwnedResources(isInstalled: IsInstalled): BundledOwnedResource[] {
  const out: BundledOwnedResource[] = [];
  for (const target of resolveManagedMcpTargets(isInstalled)) {
    const present = isMcpTargetInstalled(target);
    pushOwned(out, {
      id: `mcp:${target.id}`,
      kind: 'shared_entry',
      path: target.path,
      detail: `mcpServers.${target.serverName} (Invoker stdio shape)`,
      present,
      userModified: false,
      executePhase: 'shared',
    });
  }
  return out;
}

function discoverInstructionOwnedResources(invokerHomeRoot: string): BundledOwnedResource[] {
  const out: BundledOwnedResource[] = [];
  const cursorPath = resolveCursorRulePath();
  const cursorPresent = existsSync(cursorPath) && !lstatSync(cursorPath).isSymbolicLink();
  if (cursorPresent) {
    const cursorMatches = fileMatchesExpected(cursorPath, CURSOR_RULE_CONTENTS);
    out.push({
      id: 'instruction:cursor-rule',
      kind: 'dedicated_file',
      path: cursorPath,
      detail: CURSOR_RULE_FILE,
      present: true,
      userModified: !cursorMatches,
      executePhase: 'dedicated',
    });
  }

  const agentsPath = resolveCodexAgentsPath();
  const agentsPresent = existsSync(agentsPath)
    && !lstatSync(agentsPath).isSymbolicLink()
    && readFileSync(agentsPath, 'utf8').includes(INSTRUCTION_BEGIN);
  pushOwned(out, {
    id: 'instruction:codex-agents',
    kind: 'shared_entry',
    path: agentsPath,
    detail: `${INSTRUCTION_BEGIN} marked block`,
    present: agentsPresent,
    userModified: false,
    executePhase: 'shared',
  });

  const settingsPath = resolveClaudeSettingsPath();
  const hookPresent = claudeHookInstalled();
  pushOwned(out, {
    id: 'instruction:claude-hook-settings',
    kind: 'shared_entry',
    path: settingsPath,
    detail: `UserPromptSubmit hook containing ${CLAUDE_HOOK_MARKER}`,
    present: hookPresent,
    userModified: false,
    executePhase: 'shared',
  });

  const hookDir = resolveHookInstallDir(invokerHomeRoot);
  const hookScript = path.join(hookDir, 'claude_prompt_submit.mjs');
  const hookScriptPresent = existsSync(hookScript) && !lstatSync(hookScript).isSymbolicLink();
  const hookMatches = hookScriptPresent && fileMatchesExpected(hookScript, CLAUDE_HOOK_SCRIPT);
  if (hookScriptPresent || existsSync(hookDir)) {
    out.push({
      id: 'instruction:claude-hook-dir',
      kind: 'dedicated_dir',
      path: hookDir,
      detail: 'hooks/invoker-execution',
      present: true,
      userModified: hookScriptPresent && !hookMatches,
      executePhase: 'home',
    });
  }
  return out;
}

function discoverSkillDirResource(params: {
  id: string;
  targetPath: string;
  skillDirName: string;
  sourceDir: string | null;
  recordedNames: ReadonlySet<string>;
  executePhase: BundledOwnedExecutePhase;
}): BundledOwnedResource | null {
  const dirPath = path.join(params.targetPath, params.skillDirName);
  if (!existsSync(dirPath) || !lstatSync(dirPath).isDirectory()) return null;
  const inManifest = params.recordedNames.has(params.skillDirName);
  const fingerprintOk = params.sourceDir !== null && directoriesMatch(dirPath, params.sourceDir);
  if (!inManifest && !fingerprintOk) return null;
  return {
    id: params.id,
    kind: 'dedicated_dir',
    path: dirPath,
    detail: params.skillDirName,
    present: true,
    userModified: inManifest && params.sourceDir !== null && !fingerprintOk,
    executePhase: params.executePhase,
  };
}

function discoverCommandFileResource(params: {
  id: string;
  targetPath: string;
  fileName: string;
  sourceFile: string | null;
  recordedNames: ReadonlySet<string>;
  executePhase: BundledOwnedExecutePhase;
}): BundledOwnedResource | null {
  const filePath = path.join(params.targetPath, params.fileName);
  if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink()) return null;
  const displayName = commandDisplayName(params.fileName);
  const inManifest = params.recordedNames.has(displayName) || params.recordedNames.has(params.fileName);
  const fingerprintOk = params.sourceFile !== null
    && readFileSync(filePath).equals(readFileSync(params.sourceFile));
  if (!inManifest && !fingerprintOk) return null;
  return {
    id: params.id,
    kind: 'dedicated_file',
    path: filePath,
    detail: params.fileName,
    present: true,
    userModified: inManifest && params.sourceFile !== null && !fingerprintOk,
    executePhase: params.executePhase,
  };
}

function recordedSkillNamesForPath(
  manifest: BundledSkillsManifest | null,
  targetPath: string,
): Set<string> {
  const names = new Set<string>();
  if (!manifest?.targets) return names;
  for (const entry of Object.values(manifest.targets)) {
    if (entry.path !== targetPath) continue;
    for (const name of entry.installedSkillNames) names.add(name);
  }
  return names;
}

function recordedCommandNamesForPath(
  manifest: BundledSkillsManifest | null,
  targetPath: string,
): Set<string> {
  const names = new Set<string>();
  if (!manifest?.commandTargets) return names;
  for (const entry of Object.values(manifest.commandTargets)) {
    if (entry.path !== targetPath) continue;
    for (const name of entry.installedCommandNames) names.add(name);
  }
  return names;
}

function discoverSkillAndCommandResources(
  invokerHomeRoot: string,
  sourceRoot: string | null,
  manifest: BundledSkillsManifest | null,
): BundledOwnedResource[] {
  const out: BundledOwnedResource[] = [];
  const skillTargets: Array<{ id: string; path: string; phase: BundledOwnedExecutePhase }> = [
    { id: 'invoker', path: path.join(invokerHomeRoot, INVOKER_SKILLS_DIR), phase: 'home' },
    ...resolveHarnessSkillTargets().map((target) => ({
      id: target.id,
      path: target.path,
      phase: 'dedicated' as const,
    })),
  ];
  const commandTargets: Array<{ id: string; path: string; phase: BundledOwnedExecutePhase }> = [
    { id: 'invoker', path: path.join(invokerHomeRoot, INVOKER_COMMANDS_DIR), phase: 'home' },
    ...resolveHarnessCommandTargets().map((target) => ({
      id: target.id,
      path: target.path,
      phase: 'dedicated' as const,
    })),
  ];

  const bundledNames = sourceRoot ? listBundledSkillNames(sourceRoot) : [];
  const candidateSkillNames = new Set<string>([
    ...prefixedSkillNames(bundledNames),
    ...(manifest?.bundledSkillNames ? prefixedSkillNames(manifest.bundledSkillNames) : []),
  ]);
  if (manifest?.targets) {
    for (const entry of Object.values(manifest.targets)) {
      for (const name of entry.installedSkillNames) candidateSkillNames.add(name);
    }
  }

  for (const target of skillTargets) {
    const recorded = recordedSkillNamesForPath(manifest, target.path);
    for (const skillDirName of candidateSkillNames) {
      const bareName = skillDirName.startsWith(MANAGED_PREFIX)
        ? skillDirName.slice(MANAGED_PREFIX.length)
        : skillDirName;
      const sourceDir = sourceRoot ? path.join(sourceRoot, bareName) : null;
      const usableSource = sourceDir && existsSync(sourceDir) ? sourceDir : null;
      const resource = discoverSkillDirResource({
        id: `skill:${target.id}:${skillDirName}`,
        targetPath: target.path,
        skillDirName,
        sourceDir: usableSource,
        recordedNames: recorded,
        executePhase: target.phase,
      });
      if (resource) out.push(resource);
    }
  }

  const commandFiles = sourceRoot ? listCommandNames(sourceRoot) : [];
  const candidateCommands = new Set<string>(commandFiles);
  if (manifest?.commandTargets) {
    for (const entry of Object.values(manifest.commandTargets)) {
      for (const name of entry.installedCommandNames) {
        candidateCommands.add(name.endsWith('.md') ? name : `${name}.md`);
      }
    }
  }
  const commandSrc = sourceRoot ? commandSourceDir(sourceRoot) : null;
  for (const target of commandTargets) {
    const recorded = recordedCommandNamesForPath(manifest, target.path);
    for (const fileName of candidateCommands) {
      const normalized = fileName.endsWith('.md') ? fileName : `${fileName}.md`;
      const sourceFile = commandSrc && existsSync(path.join(commandSrc, normalized))
        ? path.join(commandSrc, normalized)
        : null;
      const resource = discoverCommandFileResource({
        id: `command:${target.id}:${normalized}`,
        targetPath: target.path,
        fileName: normalized,
        sourceFile,
        recordedNames: recorded,
        executePhase: target.phase,
      });
      if (resource) out.push(resource);
    }
  }
  return out;
}

function discoverHomeArtifactResources(invokerHomeRoot: string): BundledOwnedResource[] {
  const out: BundledOwnedResource[] = [];
  const snippetPath = resolveInvokerMcpSnippetPath(invokerHomeRoot);
  if (existsSync(snippetPath)) {
    const expected = `${JSON.stringify({ mcpServers: { [INVOKER_MCP_SERVER_NAME]: INVOKER_MCP_SERVER } }, null, 2)}\n`;
    out.push({
      id: 'home:mcp-snippet',
      kind: 'dedicated_file',
      path: snippetPath,
      detail: INVOKER_MCP_SNIPPET_RELATIVE,
      present: true,
      userModified: !fileMatchesExpected(snippetPath, expected),
      executePhase: 'home',
    });
  }
  const manifestPath = resolveManifestPath(invokerHomeRoot);
  if (existsSync(manifestPath)) {
    out.push({
      id: 'home:bundled-skills-manifest',
      kind: 'dedicated_file',
      path: manifestPath,
      detail: MANIFEST_FILE,
      present: true,
      userModified: false,
      executePhase: 'home',
    });
  }
  return out;
}

/** Discover Invoker-owned harness/skills artifacts without mutating disk. */
export function discoverBundledOwnedResources(context: BundledSkillsContext): BundledOwnedResource[] {
  const invokerHomeRoot = context.invokerHomeRoot ?? resolveInvokerHomeRoot();
  const isInstalled = context.isInstalled ?? commandExists;
  const sourceRoot = resolveBundledSkillsSourceRoot(context);
  const manifest = readManifest(invokerHomeRoot);
  return [
    ...discoverMcpOwnedResources(isInstalled),
    ...discoverInstructionOwnedResources(invokerHomeRoot),
    ...discoverSkillAndCommandResources(invokerHomeRoot, sourceRoot, manifest),
    ...discoverHomeArtifactResources(invokerHomeRoot),
  ];
}

function removeDedicatedPath(resource: BundledOwnedResource): BundledOwnedRemovalStatus {
  if (!existsSync(resource.path)) return STATUS_ABSENT;
  if (resource.userModified) return STATUS_KEPT_USER_MODIFIED;
  if (resource.kind === 'dedicated_dir') {
    rmSync(resource.path, { recursive: true, force: true });
  } else {
    if (lstatSync(resource.path).isSymbolicLink()) return STATUS_KEPT_USER_MODIFIED;
    rmSync(resource.path);
  }
  return STATUS_REMOVED;
}

function removeSharedHarnessEntry(
  resource: BundledOwnedResource,
  isInstalled: IsInstalled,
): BundledOwnedRemovalStatus {
  if (resource.id.startsWith('mcp:')) {
    const targetId = resource.id.slice('mcp:'.length);
    const target = resolveManagedMcpTargets(isInstalled).find((candidate) => candidate.id === targetId);
    if (!target || !isMcpTargetInstalled(target)) return STATUS_ABSENT;
    uninstallMcpTarget(target);
    return STATUS_REMOVED;
  }
  if (resource.id === 'instruction:codex-agents') {
    if (!codexAgentsInstalled()) return STATUS_ABSENT;
    uninstallCodexAgentsBlock();
    return STATUS_REMOVED;
  }
  if (resource.id === 'instruction:claude-hook-settings') {
    if (!claudeHookInstalled()) return STATUS_ABSENT;
    const settingsPath = resolveClaudeSettingsPath();
    if (existsSync(settingsPath) && !lstatSync(settingsPath).isSymbolicLink()) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as unknown;
      if (!isJsonRecord(parsed)) throw new Error(`Invalid Claude settings at ${settingsPath}`);
      if (isJsonRecord(parsed.hooks) && Array.isArray(parsed.hooks.UserPromptSubmit)) {
        parsed.hooks.UserPromptSubmit = parsed.hooks.UserPromptSubmit.filter((entry) => !isClaudeHookEntry(entry));
        writeFileAtomic(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`);
      }
    }
    return STATUS_REMOVED;
  }
  return STATUS_ABSENT;
}

/** Surgically remove one discovered owned resource. Skips user-modified dedicated artifacts. */
export function executeBundledOwnedResourceRemoval(
  resource: BundledOwnedResource,
  context: BundledSkillsContext,
): BundledOwnedRemovalStatus {
  const invokerHomeRoot = context.invokerHomeRoot ?? resolveInvokerHomeRoot();
  const isInstalled = context.isInstalled ?? commandExists;
  if (resource.executePhase === 'shared') {
    return removeSharedHarnessEntry(resource, isInstalled);
  }
  if (resource.id === 'instruction:cursor-rule') {
    if (!existsSync(resource.path)) return STATUS_ABSENT;
    if (resource.userModified) return STATUS_KEPT_USER_MODIFIED;
    uninstallCursorRule();
    return existsSync(resource.path) ? STATUS_ABSENT : STATUS_REMOVED;
  }
  if (resource.id === 'home:mcp-snippet') {
    if (resource.userModified) return STATUS_KEPT_USER_MODIFIED;
    if (!existsSync(resource.path)) return STATUS_ABSENT;
    removeInvokerMcpSnippet(invokerHomeRoot);
    return STATUS_REMOVED;
  }
  if (resource.id === 'home:bundled-skills-manifest') {
    if (!existsSync(resource.path)) return STATUS_ABSENT;
    rmSync(resource.path, { force: true });
    return STATUS_REMOVED;
  }
  return removeDedicatedPath(resource);
}

/**
 * Execute harness/skills cleanup in plan order: shared → dedicated → home.
 * Does not touch Invoker persistent data or npm packages.
 */
export function executeBundledIntegrationsUninstall(
  context: BundledSkillsContext,
): Array<{ resource: BundledOwnedResource; status: BundledOwnedRemovalStatus }> {
  const discovered = discoverBundledOwnedResources(context);
  const phaseOrder: BundledOwnedExecutePhase[] = ['shared', 'dedicated', 'home'];
  const results: Array<{ resource: BundledOwnedResource; status: BundledOwnedRemovalStatus }> = [];
  for (const phase of phaseOrder) {
    for (const resource of discovered.filter((entry) => entry.executePhase === phase)) {
      results.push({
        resource,
        status: executeBundledOwnedResourceRemoval(resource, context),
      });
    }
  }
  return results;
}
