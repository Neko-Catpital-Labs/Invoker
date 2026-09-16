#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function arg(name) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (hit === undefined) throw new Error(`assert-install: missing required --${name}=`);
  return hit.slice(name.length + 3);
}

const home = arg('home');
const prefix = arg('prefix');
const configPath = arg('config');
const transcriptPath = arg('transcript');
const togglesPath = arg('toggles');

const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, status: 'PASS', detail: detail ?? '' });
  } catch (error) {
    const unchecked = error instanceof UncheckedError;
    results.push({
      name,
      status: unchecked ? 'UNCHECKED' : 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

class UncheckedError extends Error {}

function readOrUnchecked(path, label) {
  if (!existsSync(path)) throw new UncheckedError(`${label} does not exist at ${path}`);
  return readFileSync(path, 'utf8');
}

const transcript = readOrUnchecked(transcriptPath, 'install transcript');
const toggles = readOrUnchecked(togglesPath, 'worker toggles read-back');

for (const section of [
  '==> Invoker quick-install',
  '==> Checking Node.js...',
  '==> Installing npm packages...',
  '==> Running doctor --fix...',
  '==> Installing skills + local MCP...',
  '==> Enabling default workers...',
  '==> GitHub auth + smoke (report only)...',
  'Quick-install complete.',
]) {
  check(`transcript has "${section}"`, () => {
    if (!transcript.includes(section)) throw new Error(`missing from install stdout`);
    return 'present';
  });
}

check('transcript reports the three default workers on', () => {
  const line = 'Workers on: pr-status, autofix, auto-approve';
  if (!transcript.includes(line)) throw new Error(`install stdout never printed "${line}"`);
  return line;
});

check('transcript reports Slack and remote machines skipped', () => {
  for (const line of ['Slack: skipped', 'Remote machines: skipped']) {
    if (!transcript.includes(line)) throw new Error(`install stdout never printed "${line}"`);
  }
  return 'both skipped';
});

check('invoker-cli landed in the sandbox npm prefix', () => {
  const bin = join(prefix, 'bin', 'invoker-cli');
  if (!existsSync(bin)) throw new Error(`no executable at ${bin}`);
  return bin;
});

check('invoker-ui landed in the sandbox npm prefix', () => {
  const pkg = join(prefix, 'lib', 'node_modules', '@neko-catpital-labs', 'invoker-ui', 'package.json');
  const fallback = join(prefix, 'node_modules', '@neko-catpital-labs', 'invoker-ui', 'package.json');
  const found = existsSync(pkg) ? pkg : existsSync(fallback) ? fallback : undefined;
  if (!found) throw new Error(`no invoker-ui package.json under ${prefix}`);
  return found;
});

const skillRoots = {
  Claude: join(home, '.claude', 'skills'),
  Cursor: join(home, '.cursor', 'skills'),
  Codex: join(home, '.codex', 'skills'),
  OMP: join(home, '.omp', 'agent', 'skills'),
};

for (const [harness, root] of Object.entries(skillRoots)) {
  check(`${harness} skills installed under the sandbox HOME`, () => {
    if (!existsSync(root)) throw new Error(`${root} was never created`);
    const managed = readdirSync(root).filter((entry) => entry.startsWith('invoker-'));
    if (managed.length === 0) throw new Error(`${root} has no invoker-* skills`);
    return `${managed.length} skill(s): ${managed.slice(0, 3).join(', ')}${managed.length > 3 ? ', …' : ''}`;
  });
}

const mcpTargets = {
  Claude: join(home, '.claude.json'),
  Cursor: join(home, '.cursor', 'mcp.json'),
  Codex: join(home, '.codex', 'config.toml'),
  OMP: join(home, '.omp', 'agent', 'mcp.json'),
};

for (const [harness, path] of Object.entries(mcpTargets)) {
  check(`${harness} MCP server registered under the sandbox HOME`, () => {
    if (!existsSync(path)) throw new Error(`${path} was never created`);
    const body = readFileSync(path, 'utf8');
    if (!body.includes('invoker')) throw new Error(`${path} exists but never mentions invoker`);
    return path;
  });
}

check('auto-approve policy toggle written to config.json', () => {
  if (!existsSync(configPath)) throw new Error(`${configPath} was never created`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config.autoApproveAIFixes !== true) {
    throw new Error(`autoApproveAIFixes is ${JSON.stringify(config.autoApproveAIFixes)}, expected true`);
  }
  return `${configPath} autoApproveAIFixes=true`;
});

for (const [label, id] of [['PR status', 'pr-status'], ['Autofix', 'autofix'], ['Auto-approve AI fixes', 'auto-approve']]) {
  check(`worker toggles read-back shows ${id} explicitly on`, () => {
    const line = toggles.split('\n').find((candidate) => candidate.trim().startsWith(`${label}:`));
    if (!line) throw new UncheckedError(`\`invoker-cli worker toggles\` printed no "${label}:" row`);
    const state = line.split(':')[1]?.trim() ?? '';
    if (state.startsWith('on (default)')) {
      throw new Error(`${label} reads "on (default)" — the install never wrote a value, it only inherited the default`);
    }
    if (!state.startsWith('on')) throw new Error(`${label} reads "${state}", expected "on"`);
    return state.split('—')[0].trim();
  });
}

const width = Math.max(...results.map((row) => row.name.length));
for (const row of results) {
  process.stdout.write(`  ${row.status.padEnd(9)} ${row.name.padEnd(width)}  ${row.detail}\n`);
}

const bad = results.filter((row) => row.status !== 'PASS');
if (bad.length > 0) {
  process.stderr.write(`\nassert-install: ${bad.length}/${results.length} check(s) not PASS\n`);
  process.exit(1);
}
process.stdout.write(`\nassert-install: ${results.length}/${results.length} checks PASS\n`);
