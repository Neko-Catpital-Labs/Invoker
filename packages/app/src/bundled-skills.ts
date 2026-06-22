import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { BundledSkillsInstallMode, BundledSkillsStatus, BundledSkillTargetStatus } from '@invoker/contracts';

import { resolveInvokerHomeRoot } from './delete-all-snapshot.js';

const MANAGED_PREFIX = 'invoker-';
const MANIFEST_FILE = 'bundled-skills.json';

interface BundledSkillsManifest {
  bundledHash: string;
  bundledSkillNames: string[];
  installedAt: string;
  lastInstallError?: string;
  targets: Record<string, { path: string; installedSkillNames: string[] }>;
}

interface BundledSkillsContext {
  isPackaged: boolean;
  repoRoot: string;
  resourcesPath?: string;
  invokerHomeRoot?: string;
}

function resolveBundledSkillsSourceRoot(context: BundledSkillsContext): string | null {
  if (context.isPackaged) {
    const resourceRoot = context.resourcesPath ?? process.resourcesPath;
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

function resolveManagedTargets(): BundledSkillTargetStatus[] {
  return [resolveCodexTarget(), resolveClaudeTarget(), resolveCursorTarget()];
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
  let staleReason: BundledSkillTargetStatus['staleReason'] | undefined;
  let diagnostic: string;

  if (!installed) {
    staleReason = 'not-installed';
    diagnostic = missingSkillNames.length > 0
      ? `Missing managed skills with prefix "${MANAGED_PREFIX}": ${missingSkillNames.join(', ')}`
      : `Managed skills with prefix "${MANAGED_PREFIX}" are not installed.`;
  } else if (upToDate) {
    diagnostic = `Installed managed skills with prefix "${MANAGED_PREFIX}" are up to date.`;
  } else if (!manifest) {
    staleReason = 'manifest-missing';
    diagnostic = `Installed managed skills with prefix "${MANAGED_PREFIX}" exist, but Invoker has no install manifest. Reinstall to verify the bundle version.`;
  } else if (!manifestTarget) {
    staleReason = 'manifest-target-missing';
    diagnostic = `Installed managed skills with prefix "${MANAGED_PREFIX}" exist, but the install manifest has no ${target.name} target entry. Reinstall to refresh diagnostics.`;
  } else if (manifestTarget.path !== target.path) {
    staleReason = 'target-path-changed';
    diagnostic = `Installed managed skills with prefix "${MANAGED_PREFIX}" are recorded for ${manifestTarget.path}, not ${target.path}. Reinstall to update this target.`;
  } else if (manifest.bundledHash !== bundledHash) {
    staleReason = 'bundle-updated';
    diagnostic = `Installed managed skills with prefix "${MANAGED_PREFIX}" are stale because the bundled source changed. Update skills to refresh them.`;
  } else {
    staleReason = 'manifest-skill-list-changed';
    diagnostic = `Installed managed skills with prefix "${MANAGED_PREFIX}" differ from the bundled skill manifest. Reinstall to restore the managed set.`;
  }

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

export function resolveBundledSkillsStatus(context: BundledSkillsContext): BundledSkillsStatus {
  const invokerHomeRoot = context.invokerHomeRoot ?? resolveInvokerHomeRoot();
  const sourceRoot = resolveBundledSkillsSourceRoot(context);
  if (!sourceRoot) {
    return {
      available: false,
      promptRecommended: false,
      managedPrefix: MANAGED_PREFIX,
      bundledSkillNames: [],
      targets: resolveManagedTargets(),
    };
  }

  const bundledSkillNames = listBundledSkillNames(sourceRoot);
  const installedNames = prefixedSkillNames(bundledSkillNames);
  const bundledHash = hashDirectory(sourceRoot);
  const manifest = readManifest(invokerHomeRoot);
  const targets = resolveManagedTargets().map((target) =>
    buildTargetStatus(target, installedNames, bundledHash, manifest),
  );

  return {
    available: true,
    promptRecommended: context.isPackaged && targets.some((target) => !target.upToDate),
    sourcePath: sourceRoot,
    managedPrefix: MANAGED_PREFIX,
    bundledSkillNames,
    lastInstallAt: manifest?.installedAt,
    lastInstallError: manifest?.lastInstallError,
    targets,
  };
}

export function installBundledSkills(
  context: BundledSkillsContext,
  mode: BundledSkillsInstallMode = 'install',
): BundledSkillsStatus {
  const invokerHomeRoot = context.invokerHomeRoot ?? resolveInvokerHomeRoot();
  const sourceRoot = resolveBundledSkillsSourceRoot(context);
  if (!sourceRoot) {
    throw new Error('Bundled skills are not available in this app build.');
  }

  const bundledSkillNames = listBundledSkillNames(sourceRoot);
  const bundledHash = hashDirectory(sourceRoot);
  const installedNames = prefixedSkillNames(bundledSkillNames);
  const targets = resolveManagedTargets();
  const manifestTargets: BundledSkillsManifest['targets'] = {};

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

  const manifest: BundledSkillsManifest = {
    bundledHash,
    bundledSkillNames,
    installedAt: new Date().toISOString(),
    targets: manifestTargets,
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
