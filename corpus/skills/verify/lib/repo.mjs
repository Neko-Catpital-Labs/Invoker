import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function resolveRepoRoot(from = __dirname) {
  let dir = resolve(from);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(__dirname, '../../../..');
}

export function verifySkillDir(repoRoot = resolveRepoRoot()) {
  const corpusDir = join(repoRoot, 'corpus/skills/verify');
  if (existsSync(corpusDir)) return corpusDir;
  return join(repoRoot, 'skills/verify');
}

export function featuresDir(repoRoot = resolveRepoRoot()) {
  return join(verifySkillDir(repoRoot), 'references/features');
}

export function controlInvokerPath(repoRoot = resolveRepoRoot()) {
  return join(repoRoot, 'skills/verify/control-invoker.mjs');
}
