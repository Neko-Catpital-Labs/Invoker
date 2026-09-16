#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(REPO_ROOT, 'packages/app/src/headless-command-registry.ts');
const CLI = join(REPO_ROOT, 'packages/cli/src/index.ts');
const DEBT = join(REPO_ROOT, 'scripts/cli-headless-parity-debt.txt');

const SPECIAL_CLI_SPELLINGS = new Map([
  ['owner-serve', 'owner'],
  ['install-skills', 'install'],
]);

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`fail\t${path}: ${error.message}`);
    process.exit(2);
  }
}

function headlessCommands(source) {
  const block = source.match(/export const HEADLESS_COMMANDS = \[([\s\S]*?)\] as const/);
  if (!block) {
    console.error('fail\tHEADLESS_COMMANDS not found; the registry shape changed and this gate cannot run');
    process.exit(2);
  }
  const found = [...block[1].matchAll(/\{\s*name:\s*'([^']+)',\s*kind:\s*'([^']+)'\s*\}/g)];
  if (found.length === 0) {
    console.error('fail\tHEADLESS_COMMANDS parsed to zero entries; refusing to report a vacuous pass');
    process.exit(2);
  }
  return found.map(([, name, kind]) => ({ name, kind }));
}

function cliVerbs(source) {
  const verbs = new Set();
  for (const [, name] of source.matchAll(/argv\[0\] === '([^']+)'/g)) verbs.add(name);
  for (const [, name] of source.matchAll(/parsed\.command === '([^']+)'/g)) verbs.add(name);
  for (const [, name] of source.matchAll(/parsed\.command !== '([^']+)'/g)) verbs.add(name);
  for (const [, name] of source.matchAll(/case '([^']+)':/g)) verbs.add(name);
  if (verbs.size === 0) {
    console.error('fail\tno CLI dispatch verbs parsed; refusing to report a vacuous pass');
    process.exit(2);
  }
  return verbs;
}

function debtList(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

function isExposed(command, verbs) {
  if (verbs.has(command)) return true;
  const alias = SPECIAL_CLI_SPELLINGS.get(command);
  return alias !== undefined && verbs.has(alias);
}

const commands = headlessCommands(read(REGISTRY));
const verbs = cliVerbs(read(CLI));
const debt = debtList(read(DEBT));

if (process.argv.includes('--list')) {
  for (const { name, kind } of commands) {
    console.log(`${isExposed(name, verbs) ? 'cli' : '---'}\t${kind}\t${name}`);
  }
  process.exit(0);
}

const errors = [];

for (const { name } of commands) {
  if (isExposed(name, verbs)) continue;
  if (debt.includes(name)) continue;
  errors.push(`${name}: headless command has no invoker-cli surface; teach the CLI the verb or add it to scripts/cli-headless-parity-debt.txt`);
}

for (const name of debt) {
  if (!commands.some((command) => command.name === name)) {
    errors.push(`${name}: on the parity debt list but not a headless command; drop the stale entry`);
  } else if (isExposed(name, verbs)) {
    errors.push(`${name}: invoker-cli now exposes this; remove it from scripts/cli-headless-parity-debt.txt (the list is shrink-only)`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`fail\t${error}`);
  process.exit(1);
}

const exposed = commands.filter(({ name }) => isExposed(name, verbs)).length;
console.log(`ok\tcli/headless parity (${exposed}/${commands.length} exposed, ${debt.length} on the shrink-only debt list)`);
