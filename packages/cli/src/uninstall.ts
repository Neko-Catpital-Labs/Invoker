import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  readInvokerConfigFile,
  resolveRepoRoot,
  writeInvokerConfigFile,
} from '@invoker/contracts';
import {
  discoverBundledOwnedResources,
  executeBundledIntegrationsUninstall,
  type BundledOwnedResource,
  type BundledOwnedRemovalStatus,
} from '@invoker/shell/bundled-skills';
import {
  installExperimentalPlannerMcp,
  readExperimentalPlannerSetup,
} from './onboarding.js';
import {
  QUICK_INSTALL_WORKER_IDS,
} from './quick-install.js';
import {
  applyDesiredStateWorkerToggle,
  applyWorkerToggle,
  findWorkerToggle,
  isDesiredStateWorkerToggle,
  isPolicyWorkerToggle,
  openWorkerDesiredStateStore,
  readDesiredStateWorkerToggleValue,
  readWorkerToggleValue,
  resolveCliInstanceProfile,
} from './worker-toggles.js';

export type UninstallResourceKind =
  | 'dedicated_file'
  | 'dedicated_dir'
  | 'shared_entry'
  | 'npm_package'
  | 'invoker_home_data'
  | 'worker_toggle';

export type UninstallResourceStatus =
  | 'planned'
  | 'removed'
  | 'kept (user-modified)'
  | 'kept (--keep-data)'
  | 'absent'
  | `failed: ${string}`;

export interface UninstallResource {
  id: string;
  kind: UninstallResourceKind;
  path: string;
  detail: string;
  present: boolean;
  userModified: boolean;
  scope: 'integration' | 'data' | 'npm';
}

export interface UninstallCoverageRow {
  area: string;
  coverage: 'supported' | 'excluded';
  note: string;
}

export const UNINSTALL_NPM_PACKAGES = [
  '@neko-catpital-labs/invoker-cli',
  '@neko-catpital-labs/invoker-ui',
  '@neko-catpital-labs/invoker-slack',
  '@neko-catpital-labs/invoker-watcher',
] as const;

const STANDALONE_CLI_HOME_NAME = '.invoker-cli';
const CONFIRM_PROMPT_WITH_DATA =
  'Proceed with uninstall? This removes Invoker integrations and home data. [y/N] ';
const CONFIRM_PROMPT_KEEP_DATA =
  'Proceed with uninstall of Invoker integrations (keeping home data)? [y/N] ';
const REFUSE_NON_TTY_MESSAGE =
  'Refusing destructive uninstall without --yes (stdin is not a TTY). Re-run with --yes, or use --dry-run.';
const HOME_DATA_ID_PREFIX = 'data:home:';
const KEEP_DATA_STATUS = 'kept (--keep-data)' as const;

export type UninstallResultEntry = {
  resource: UninstallResource;
  status: UninstallResourceStatus;
};

export type UninstallIO = {
  print: (line: string) => void;
  interactive: boolean;
  prompt?: (question: string) => Promise<string>;
};

export type UninstallDeps = {
  discover?: () => UninstallResource[];
  executeIntegrations?: (resources: UninstallResource[]) => Promise<UninstallResultEntry[]>;
  listGlobalNpmPackages?: () => ReadonlySet<string>;
  uninstallNpmPackage?: (packageName: string) => void;
  removePath?: (targetPath: string) => void;
  resolveSkillsContext?: () => {
    isPackaged: boolean;
    repoRoot: string;
    resourcesPath?: string;
    invokerHomeRoot: string;
  };
};

export interface UninstallOptions {
  dryRun: boolean;
  yes: boolean;
  keepData: boolean;
  help: boolean;
}

function defaultIO(): UninstallIO {
  return {
    print: (line) => process.stdout.write(`${line}\n`),
    interactive: Boolean(process.stdin.isTTY),
  };
}

export function parseUninstallArgs(argv: string[]): UninstallOptions {
  const options: UninstallOptions = {
    dryRun: false,
    yes: false,
    keepData: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--keep-data') options.keepData = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`Unknown uninstall option: ${arg}`);
  }
  return options;
}

export function formatUninstallHelp(): string {
  return [
    'Usage: invoker-cli uninstall [--dry-run] [--yes] [--keep-data]',
    '',
    'Discover and remove Invoker-owned integrations, home data, and global npm packages',
    'installed by invoker-cli install / setup. npm packages are removed last.',
    '',
    'Flags:',
    '  --dry-run     Print the deletion plan and coverage table without mutating disk.',
    '  --yes         Skip the confirmation prompt (required when stdin is not a TTY).',
    '  --keep-data   Skip Invoker home data purge; report paths as kept (--keep-data).',
    '',
    'Exit codes:',
    '  0  Already clean, dry-run, help, or all intended removals succeeded (including policy keeps).',
    '  1  Confirmation refused, or any in-scope owned resource removal failed.',
    '',
    'Coverage:',
    ...formatCoverageTable(uninstallCoverageTable()).map((line) => `  ${line}`),
  ].join('\n');
}

export function uninstallCoverageTable(): UninstallCoverageRow[] {
  return [
    {
      area: 'setup --register-harnesses / leftover home skill cleanup',
      coverage: 'supported',
      note: 'Harness skill/MCP/instruction entries; leftover home skill/snippet cleanup; manifest',
    },
    {
      area: 'setup --register-harnesses',
      coverage: 'supported',
      note: 'Surgical MCP/instruction entries; dedicated managed artifacts',
    },
    {
      area: 'Quick-install worker toggles',
      coverage: 'supported',
      note: 'Disable pr-status / autofix / auto-approve when stores remain',
    },
    {
      area: 'Experimental planner MCP entry',
      coverage: 'supported',
      note: 'Shared mcp.json entry + experimentalPlanner flag',
    },
    {
      area: 'Global npm packages (@neko-catpital-labs/invoker-*)',
      coverage: 'supported',
      note: 'Removed last after integrations and home data',
    },
    {
      area: 'Invoker home data (config, .env, DB, outputs)',
      coverage: 'supported',
      note: 'Current CLI home + ~/.invoker-cli when present; skip with --keep-data',
    },
    {
      area: 'Desktop install.sh channels (DMG / AppImage / .deb)',
      coverage: 'excluded',
      note: 'Not removed by invoker-cli uninstall',
    },
  ];
}

export function formatCoverageTable(rows: UninstallCoverageRow[]): string[] {
  const lines = ['Coverage:', '  supported | excluded | area'];
  for (const row of rows) {
    lines.push(`  ${row.coverage.padEnd(9)} | ${row.area} — ${row.note}`);
  }
  return lines;
}

function defaultListGlobalNpmPackages(): ReadonlySet<string> {
  const present = new Set<string>();
  for (const name of UNINSTALL_NPM_PACKAGES) {
    const result = spawnSync('npm', ['ls', '-g', '--depth=0', '--json', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if ((result.status ?? 1) !== 0) continue;
    try {
      const parsed = JSON.parse(result.stdout || '{}') as { dependencies?: Record<string, unknown> };
      if (parsed.dependencies && name in parsed.dependencies) present.add(name);
    } catch {
      continue;
    }
  }
  return present;
}

function resolveDefaultSkillsContext(): {
  isPackaged: boolean;
  repoRoot: string;
  resourcesPath?: string;
  invokerHomeRoot: string;
} {
  const profile = resolveCliInstanceProfile();
  let repoRoot = process.cwd();
  try {
    repoRoot = resolveRepoRoot(process.cwd());
  } catch {
  }
  return {
    isPackaged: false,
    repoRoot,
    invokerHomeRoot: profile.homeRoot,
  };
}

function homeDataPaths(homeRoot: string): Array<{ id: string; path: string; detail: string }> {
  return [
    { id: `data:config:${homeRoot}`, path: join(homeRoot, 'config.json'), detail: 'config.json' },
    { id: `data:env:${homeRoot}`, path: join(homeRoot, '.env'), detail: '.env' },
    { id: `data:db:${homeRoot}`, path: join(homeRoot, 'invoker.db'), detail: 'invoker.db' },
    { id: `data:outputs:${homeRoot}`, path: join(homeRoot, 'outputs'), detail: 'outputs/' },
    { id: `data:log:${homeRoot}`, path: join(homeRoot, 'invoker.log'), detail: 'invoker.log' },
  ];
}

function scopedHomeRoots(): string[] {
  const profile = resolveCliInstanceProfile();
  const roots = [profile.homeRoot];
  const standalone = join(homedir(), STANDALONE_CLI_HOME_NAME);
  if (standalone !== profile.homeRoot) roots.push(standalone);
  return roots;
}

function fromBundled(resource: BundledOwnedResource): UninstallResource {
  return {
    id: resource.id,
    kind: resource.kind,
    path: resource.path,
    detail: resource.detail,
    present: resource.present,
    userModified: resource.userModified,
    scope: 'integration',
  };
}

function discoverWorkerToggleResources(): UninstallResource[] {
  const out: UninstallResource[] = [];
  const configPath = resolveCliInstanceProfile().configPath;
  const configExists = existsSync(configPath);
  const config = configExists ? readInvokerConfigFile(configPath) : {};
  for (const id of QUICK_INSTALL_WORKER_IDS) {
    const spec = findWorkerToggle(id);
    if (!spec) continue;
    let enabled = false;
    if (isPolicyWorkerToggle(spec) && configExists) {
      enabled = readWorkerToggleValue(config, spec) === true;
    }
    out.push({
      id: `worker:${id}`,
      kind: 'worker_toggle',
      path: isPolicyWorkerToggle(spec) ? configPath : join(resolveCliInstanceProfile().homeRoot, 'invoker.db'),
      detail: `quick-install worker toggle ${id}`,
      present: enabled,
      userModified: false,
      scope: 'integration',
    });
  }
  return out;
}

async function discoverDesiredStateWorkerResources(): Promise<UninstallResource[]> {
  const out: UninstallResource[] = [];
  const dbPath = join(resolveCliInstanceProfile().homeRoot, 'invoker.db');
  if (!existsSync(dbPath)) return out;
  const store = await openWorkerDesiredStateStore();
  try {
    for (const id of QUICK_INSTALL_WORKER_IDS) {
      const spec = findWorkerToggle(id);
      if (!spec || !isDesiredStateWorkerToggle(spec)) continue;
      const value = readDesiredStateWorkerToggleValue(store, spec);
      out.push({
        id: `worker-desired:${id}`,
        kind: 'worker_toggle',
        path: dbPath,
        detail: `desired-state worker toggle ${id}`,
        present: value === true,
        userModified: false,
        scope: 'integration',
      });
    }
  } finally {
    store.close?.();
  }
  return out;
}

function discoverExperimentalPlannerResource(): UninstallResource {
  const state = readExperimentalPlannerSetup();
  return {
    id: 'planner:experimental',
    kind: 'shared_entry',
    path: state.targetPath,
    detail: 'experimental-planner MCP entry + flag',
    present: state.installed || state.experimentalPlanner,
    userModified: false,
    scope: 'integration',
  };
}

function discoverDataResources(): UninstallResource[] {
  const out: UninstallResource[] = [];
  for (const homeRoot of scopedHomeRoots()) {
    if (!existsSync(homeRoot)) continue;
    out.push({
      id: `data:home:${homeRoot}`,
      kind: 'invoker_home_data',
      path: homeRoot,
      detail: 'Invoker home root (persistent data)',
      present: true,
      userModified: false,
      scope: 'data',
    });
    for (const entry of homeDataPaths(homeRoot)) {
      if (!existsSync(entry.path)) continue;
      out.push({
        id: entry.id,
        kind: 'invoker_home_data',
        path: entry.path,
        detail: entry.detail,
        present: true,
        userModified: false,
        scope: 'data',
      });
    }
  }
  return out;
}

function discoverNpmResources(listGlobal: () => ReadonlySet<string>): UninstallResource[] {
  const present = listGlobal();
  return UNINSTALL_NPM_PACKAGES.map((name) => ({
    id: `npm:${name}`,
    kind: 'npm_package' as const,
    path: name,
    detail: 'npm global package',
    present: present.has(name),
    userModified: false,
    scope: 'npm' as const,
  })).filter((resource) => resource.present);
}

export async function discoverUninstallResources(deps: UninstallDeps = {}): Promise<UninstallResource[]> {
  if (deps.discover) return deps.discover();
  const skillsContext = (deps.resolveSkillsContext ?? resolveDefaultSkillsContext)();
  const bundled = discoverBundledOwnedResources(skillsContext).map(fromBundled);
  const workers = [
    ...discoverWorkerToggleResources().filter((resource) => resource.present),
    ...(await discoverDesiredStateWorkerResources()).filter((resource) => resource.present),
  ];
  const planner = discoverExperimentalPlannerResource();
  const plannerResources = planner.present ? [planner] : [];
  const data = discoverDataResources();
  const npm = discoverNpmResources(deps.listGlobalNpmPackages ?? defaultListGlobalNpmPackages);
  return [...bundled, ...workers, ...plannerResources, ...data, ...npm];
}

export function formatUninstallPlan(resources: UninstallResource[]): string[] {
  const lines: string[] = ['Uninstall plan:', ''];
  if (resources.length === 0) {
    lines.push('  (no Invoker-owned resources found)');
    lines.push('');
    return lines;
  }
  for (const resource of resources) {
    const modified = resource.userModified ? ' [user-modified → keep]' : '';
    lines.push(`  - [${resource.kind}] ${resource.path}`);
    lines.push(`      ${resource.detail}${modified}`);
  }
  lines.push('');
  return lines;
}

function mapBundledStatus(status: BundledOwnedRemovalStatus): UninstallResourceStatus {
  return status;
}

function defaultRemovePath(targetPath: string): void {
  if (!existsSync(targetPath)) return;
  const stats = lstatSync(targetPath);
  if (stats.isDirectory()) {
    rmSync(targetPath, { recursive: true, force: true });
    return;
  }
  rmSync(targetPath, { force: true });
}

function defaultUninstallNpmPackage(packageName: string): void {
  const result = spawnSync('npm', ['uninstall', '-g', packageName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if ((result.status ?? 1) === 0) return;
  const detail = (result.stderr || result.stdout || `npm uninstall -g ${packageName} failed`).trim();
  throw new Error(detail);
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function failureStatus(error: unknown): UninstallResourceStatus {
  const message = error instanceof Error ? error.message : String(error);
  return `failed: ${message}`;
}

function removeOwnedPath(
  resource: UninstallResource,
  removePath: (targetPath: string) => void,
): UninstallResourceStatus {
  if (!existsSync(resource.path)) return 'absent';
  try {
    removePath(resource.path);
    return 'removed';
  } catch (error) {
    return failureStatus(error);
  }
}

export function executeDataPurge(
  resources: UninstallResource[],
  options: Pick<UninstallOptions, 'keepData'>,
  deps: UninstallDeps = {},
): UninstallResultEntry[] {
  const dataResources = resources.filter((resource) => resource.scope === 'data' && resource.present);
  if (options.keepData) {
    return dataResources.map((resource) => ({ resource, status: KEEP_DATA_STATUS }));
  }
  const removePath = deps.removePath ?? defaultRemovePath;
  const homeResources = dataResources.filter((resource) => resource.id.startsWith(HOME_DATA_ID_PREFIX));
  const nestedResources = dataResources.filter((resource) => !resource.id.startsWith(HOME_DATA_ID_PREFIX));
  const homeResults = homeResources.map((resource) => ({
    resource,
    status: removeOwnedPath(resource, removePath),
  }));
  const removedHomes = homeResults
    .filter((entry) => entry.status === 'removed')
    .map((entry) => entry.resource.path);
  const nestedResults = nestedResources.map((resource) => {
    if (!existsSync(resource.path)) {
      const covered = removedHomes.some((homePath) => isPathInside(resource.path, homePath));
      return { resource, status: (covered ? 'removed' : 'absent') as UninstallResourceStatus };
    }
    return { resource, status: removeOwnedPath(resource, removePath) };
  });
  return [...homeResults, ...nestedResults];
}

export function executeNpmUninstall(
  resources: UninstallResource[],
  deps: UninstallDeps = {},
): UninstallResultEntry[] {
  const npmResources = resources.filter((resource) => resource.scope === 'npm' && resource.present);
  const uninstallNpm = deps.uninstallNpmPackage ?? defaultUninstallNpmPackage;
  return npmResources.map((resource) => {
    try {
      uninstallNpm(resource.path);
      return { resource, status: 'removed' as const };
    } catch (error) {
      return { resource, status: failureStatus(error) };
    }
  });
}

async function disableQuickInstallWorkers(): Promise<UninstallResultEntry[]> {
  const results: Array<{ resource: UninstallResource; status: UninstallResourceStatus }> = [];
  const profile = resolveCliInstanceProfile();
  const configPath = profile.configPath;
  let config = existsSync(configPath) ? readInvokerConfigFile(configPath) : null;
  let configChanged = false;
  const dbPath = join(profile.homeRoot, 'invoker.db');
  const desiredStore = existsSync(dbPath) ? await openWorkerDesiredStateStore() : null;
  try {
    for (const id of QUICK_INSTALL_WORKER_IDS) {
      const spec = findWorkerToggle(id);
      if (!spec) continue;
      const resource: UninstallResource = {
        id: `worker:${id}`,
        kind: 'worker_toggle',
        path: isPolicyWorkerToggle(spec) ? configPath : dbPath,
        detail: `quick-install worker toggle ${id}`,
        present: true,
        userModified: false,
        scope: 'integration',
      };
      try {
        if (isDesiredStateWorkerToggle(spec)) {
          if (!desiredStore) {
            results.push({ resource, status: 'absent' });
            continue;
          }
          const before = readDesiredStateWorkerToggleValue(desiredStore, spec);
          if (before !== true) {
            results.push({ resource, status: 'absent' });
            continue;
          }
          applyDesiredStateWorkerToggle(desiredStore, spec, false);
          results.push({ resource, status: 'removed' });
          continue;
        }
        if (isPolicyWorkerToggle(spec)) {
          if (!config) {
            results.push({ resource, status: 'absent' });
            continue;
          }
          if (readWorkerToggleValue(config, spec) !== true) {
            results.push({ resource, status: 'absent' });
            continue;
          }
          config = applyWorkerToggle(config, spec, false);
          configChanged = true;
          results.push({ resource, status: 'removed' });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ resource, status: `failed: ${message}` });
      }
    }
  } finally {
    desiredStore?.close?.();
  }
  if (configChanged && config) {
    writeInvokerConfigFile(configPath, config);
  }
  return results;
}

async function defaultExecuteIntegrations(
  _resources: UninstallResource[],
  deps: UninstallDeps,
): Promise<UninstallResultEntry[]> {
  const skillsContext = (deps.resolveSkillsContext ?? resolveDefaultSkillsContext)();
  const bundledResults = executeBundledIntegrationsUninstall(skillsContext).map(({ resource, status }) => ({
    resource: fromBundled(resource),
    status: mapBundledStatus(status),
  }));
  const workerResults = (await disableQuickInstallWorkers())
    .filter((entry) => entry.status !== 'absent');
  const plannerState = readExperimentalPlannerSetup();
  const plannerResults: UninstallResultEntry[] = [];
  if (plannerState.installed || plannerState.experimentalPlanner) {
    const resource = discoverExperimentalPlannerResource();
    try {
      installExperimentalPlannerMcp({ uninstall: true });
      plannerResults.push({ resource, status: 'removed' });
    } catch (error) {
      plannerResults.push({ resource, status: failureStatus(error) });
    }
  }
  return [...bundledResults, ...workerResults, ...plannerResults];
}

export function formatUninstallReport(
  results: UninstallResultEntry[],
  remaining: UninstallResource[],
): string[] {
  const lines: string[] = ['Uninstall report:', ''];
  for (const { resource, status } of results) {
    lines.push(`  ${status}: [${resource.kind}] ${resource.path}`);
  }
  if (remaining.length > 0) {
    lines.push('');
    lines.push('Remaining (kept with --keep-data):');
    for (const resource of remaining) {
      lines.push(`  - [${resource.kind}] ${resource.path} — ${resource.detail}`);
    }
  }
  lines.push('');
  return lines;
}

export function uninstallExitCode(
  results: Array<{ status: UninstallResourceStatus }>,
): number {
  return results.some((entry) => entry.status.startsWith('failed:')) ? 1 : 0;
}

function confirmPromptFor(options: UninstallOptions): string {
  return options.keepData ? CONFIRM_PROMPT_KEEP_DATA : CONFIRM_PROMPT_WITH_DATA;
}

async function confirmOrRefuse(
  options: UninstallOptions,
  io: UninstallIO,
): Promise<'proceed' | 'refuse'> {
  if (options.yes) return 'proceed';
  if (!io.interactive) {
    io.print(REFUSE_NON_TTY_MESSAGE);
    return 'refuse';
  }
  const prompt = io.prompt ?? (async (question: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  });
  const answer = (await prompt(confirmPromptFor(options))).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return 'proceed';
  io.print('Uninstall cancelled.');
  return 'refuse';
}

function remainingAfterUninstall(
  options: UninstallOptions,
  resources: UninstallResource[],
): UninstallResource[] {
  if (!options.keepData) return [];
  return resources.filter((resource) => resource.scope === 'data' && resource.present);
}

export async function runUninstall(
  argv: string[] = [],
  io: UninstallIO = defaultIO(),
  deps: UninstallDeps = {},
): Promise<number> {
  const options = parseUninstallArgs(argv);
  if (options.help) {
    io.print(formatUninstallHelp());
    return 0;
  }

  const resources = await discoverUninstallResources(deps);
  for (const line of formatUninstallPlan(resources)) io.print(line);
  for (const line of formatCoverageTable(uninstallCoverageTable())) io.print(line);
  io.print('');

  if (options.dryRun) {
    io.print('Dry-run complete. No changes were made.');
    return 0;
  }

  const decision = await confirmOrRefuse(options, io);
  if (decision === 'refuse') return 1;

  const execute = deps.executeIntegrations
    ?? ((planned) => defaultExecuteIntegrations(planned, deps));
  const integrationResults = await execute(resources.filter((resource) => resource.scope === 'integration'));
  const dataResults = executeDataPurge(resources, options, deps);
  const npmResults = executeNpmUninstall(resources, deps);
  const results = [...integrationResults, ...dataResults, ...npmResults];
  const remaining = remainingAfterUninstall(options, resources);
  for (const line of formatUninstallReport(results, remaining)) io.print(line);
  return uninstallExitCode(results);
}
