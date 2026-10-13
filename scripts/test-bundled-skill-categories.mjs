#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(REPO_ROOT, 'skills');
const SELECTABLE_CATEGORIES = ['core', 'optimization'];

function listBundledSkillNames() {
  return readdirSync(SOURCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(SOURCE_ROOT, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function readBundledSkillCategory(name) {
  const lines = readFileSync(path.join(SOURCE_ROOT, name, 'SKILL.md'), 'utf8').split('\n');
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

const names = listBundledSkillNames();
if (names.length === 0) {
  console.error(`FAIL: no bundled skills found under ${SOURCE_ROOT}; the check could not run`);
  process.exit(1);
}

const missing = [];
const unknown = [];
const byCategory = new Map(SELECTABLE_CATEGORIES.map((category) => [category, []]));

for (const name of names) {
  const category = readBundledSkillCategory(name);
  if (category === null) {
    missing.push(name);
    continue;
  }
  if (!byCategory.has(category)) {
    unknown.push(`${name} (category: ${category})`);
    continue;
  }
  byCategory.get(category).push(name);
}

const covered = SELECTABLE_CATEGORIES.reduce((total, category) => total + byCategory.get(category).length, 0);

for (const name of missing) {
  console.error(`FAIL: skills/${name}/SKILL.md has no category: field, so INVOKER_SKILL_CATEGORY installs silently omit it`);
}
for (const entry of unknown) {
  console.error(`FAIL: skills/${entry} is not one of ${SELECTABLE_CATEGORIES.join(', ')}`);
}

if (missing.length > 0 || unknown.length > 0 || covered !== names.length) {
  console.error(`FAIL: ${covered}/${names.length} bundled skills are reachable by a filtered install`);
  process.exit(1);
}

for (const category of SELECTABLE_CATEGORIES) {
  console.log(`PASS: ${category} -> ${byCategory.get(category).length} skills`);
}
console.log(`PASS: all ${names.length} bundled skills carry a selectable category`);
