import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const YAML_DIST = 'node_modules/yaml/dist/index.js';
const REPO_YAML_DIST = `packages/app/${YAML_DIST}`;

function readManifest() {
  try {
    const invokerHome = process.env.INVOKER_DB_DIR ?? resolve(homedir(), '.invoker');
    return JSON.parse(readFileSync(resolve(invokerHome, 'bundled-skills.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function resolveInvokerRepoRoot(scriptDir) {
  const hasWorkspaceMarker = (dir) => existsSync(resolve(dir, 'pnpm-workspace.yaml'));

  const envRoot = process.env.INVOKER_REPO_ROOT;
  if (envRoot && hasWorkspaceMarker(envRoot)) return resolve(envRoot);

  const localRepoRoot = resolve(scriptDir, '../../..');
  if (hasWorkspaceMarker(localRepoRoot)) return localRepoRoot;

  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd: scriptDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const sharedRepoRoot = resolve(scriptDir, gitCommonDir, '..');
    if (hasWorkspaceMarker(sharedRepoRoot)) return sharedRepoRoot;
  } catch {
    // no git checkout around this script
  }

  const manifest = readManifest();
  if (manifest && typeof manifest.sourceRepoRoot === 'string' && hasWorkspaceMarker(manifest.sourceRepoRoot)) {
    return resolve(manifest.sourceRepoRoot);
  }

  return null;
}

export async function importYaml(scriptDir) {
  try {
    return await import('yaml');
  } catch {
    // not running inside an install that declares yaml; fall through
  }

  const repoRoot = resolveInvokerRepoRoot(scriptDir);
  if (repoRoot) {
    for (const candidate of [REPO_YAML_DIST, YAML_DIST]) {
      const yamlPath = resolve(repoRoot, candidate);
      if (existsSync(yamlPath)) return import(yamlPath);
    }
  }

  const manifest = readManifest();
  if (manifest && typeof manifest.yamlModuleRoot === 'string') {
    const yamlPath = resolve(manifest.yamlModuleRoot, YAML_DIST);
    if (existsSync(yamlPath)) return import(yamlPath);
  }

  throw new Error(
    'Unable to resolve yaml runtime. Set INVOKER_REPO_ROOT to an Invoker checkout, or reinstall so '
    + 'bundled-skills.json records a yamlModuleRoot. Checked, in order: a plain \'yaml\' import '
    + '(present inside the invoker-cli npm install, which declares it); '
    + 'packages/app/node_modules/yaml in a resolvable Invoker checkout via INVOKER_REPO_ROOT, a live '
    + 'git checkout, or bundled-skills.json sourceRepoRoot; and bundled-skills.json yamlModuleRoot '
    + 'recorded by a packaged install.',
  );
}
