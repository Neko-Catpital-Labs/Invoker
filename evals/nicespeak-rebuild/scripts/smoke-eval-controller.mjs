#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(root, '../..');

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

run('node', [join(root, 'scripts/render-pilot.mjs')], { cwd: repoRoot });
const index = JSON.parse(readFileSync(join(root, 'generated/pilot/index.json'), 'utf8'));
if (index.lineages.length !== 4) throw new Error('expected 4 lineages');
for (const lineage of index.lineages) {
  if (lineage.chain.length !== 10) throw new Error(`expected 10 features for ${lineage.id}`);
}
for (const [featureId, hash] of Object.entries(index.crossModelPromptHashes)) {
  for (const lineage of index.lineages) {
    const entry = lineage.chain.find((c) => c.featureId === featureId);
    if (entry.crossModelPromptHash !== hash) {
      throw new Error(`hash drift ${featureId}`);
    }
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'nicespeak-audit-'));
const clean = join(tmp, 'clean.txt');
const dirty = join(tmp, 'dirty.txt');
writeFileSync(clean, 'implemented from local specs only\n');
writeFileSync(dirty, 'cloned https://github.com/Neko-Catpital-Labs/NiceSpeak\n');
run('node', [join(root, 'scripts/audit-transcript.mjs'), clean]);
const dirtyResult = spawnSync('node', [join(root, 'scripts/audit-transcript.mjs'), dirty], { encoding: 'utf8' });
if (dirtyResult.status !== 2) {
  throw new Error(`expected dirty audit exit 2, got ${dirtyResult.status}`);
}
rmSync(tmp, { recursive: true, force: true });

console.log('EVAL_CONTROLLER_SMOKE_OK');
