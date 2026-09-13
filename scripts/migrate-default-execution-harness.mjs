#!/usr/bin/env node

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const localPath = process.env.INVOKER_REPO_CONFIG_PATH?.trim() || join(homedir(), '.invoker', 'config.json');
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const backupSuffix = `.bak.default-execution-harness-${timestamp}`;

export function migrateJson(text, label, { consumerSupportsHarness = false } = {}) {
  if (!consumerSupportsHarness) {
    throw new Error(
      'Refusing defaultExecutionHarness migration: installed consumer capability was not proven. ' +
      'Re-run after deploying a consumer that supports defaultExecutionHarness with --consumer-supports-harness.',
    );
  }
  const config = JSON.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  if (config.defaultExecutionHarness === undefined && config.defaultExecutionAgent !== undefined) {
    config.defaultExecutionHarness = config.defaultExecutionAgent;
  }
  delete config.defaultExecutionAgent;
  return `${JSON.stringify(config, null, 2)}\n`;
}

function migrateLocal(consumerSupportsHarness) {
  if (!existsSync(localPath)) {
    console.log(`LOCAL skipped missing ${localPath}`);
    return null;
  }
  const original = readFileSync(localPath, 'utf8');
  const migrated = migrateJson(original, localPath, { consumerSupportsHarness });
  if (migrated === original) {
    console.log(`LOCAL unchanged ${localPath}`);
    return null;
  }
  const backup = `${localPath}${backupSuffix}`;
  renameSync(localPath, backup);
  writeFileSync(localPath, migrated, { mode: 0o600 });
  console.log(`LOCAL migrated ${localPath} backup=${backup}`);
  console.log(JSON.stringify({ defaultExecutionHarness: JSON.parse(migrated).defaultExecutionHarness, defaultExecutionModel: JSON.parse(migrated).defaultExecutionModel }));
}

function remoteScript(configPath, backupSuffixValue) {
  return `
set -eu
config_path=$(printf '%s' "$1")
backup_path="${configPath}${backupSuffixValue}"
node - "$config_path" "$backup_path" <<'NODE'
const fs = require('node:fs');
const [configPath, backupPath] = process.argv.slice(2);
if (!fs.existsSync(configPath)) { console.log('REMOTE skipped missing ' + configPath); process.exit(0); }
const original = fs.readFileSync(configPath, 'utf8');
const config = JSON.parse(original);
if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(configPath + ' must contain a JSON object');
if (config.defaultExecutionHarness === undefined && config.defaultExecutionAgent !== undefined) config.defaultExecutionHarness = config.defaultExecutionAgent;
delete config.defaultExecutionAgent;
const migrated = JSON.stringify(config, null, 2) + '\\n';
if (migrated === original) { console.log('REMOTE unchanged ' + configPath); process.exit(0); }
fs.renameSync(configPath, backupPath);
fs.writeFileSync(configPath, migrated, { mode: 0o600 });
console.log('REMOTE migrated ' + configPath + ' backup=' + backupPath);
console.log(JSON.stringify({ defaultExecutionHarness: config.defaultExecutionHarness, defaultExecutionModel: config.defaultExecutionModel }));
NODE
`;
}

export function runMigration(argv = process.argv.slice(2)) {
  const consumerSupportsHarness = argv.includes('--consumer-supports-harness');
  if (argv.includes('--local-only')) {
    migrateLocal(consumerSupportsHarness);
    return;
  }

  migrateLocal(consumerSupportsHarness);
  const localConfig = JSON.parse(readFileSync(localPath, 'utf8'));
  for (const [id, target] of Object.entries(localConfig.remoteTargets ?? {})) {
    if (!id.includes('digital_ocean') || !target?.host || !target?.user || !target?.sshKeyPath) continue;
    const remoteConfigPath = `${target.remoteInvokerHome || '~/.invoker'}/config.json`;
    const expandedPath = remoteConfigPath.startsWith('~/') ? `$HOME/${remoteConfigPath.slice(2)}` : remoteConfigPath;
    const command = remoteScript(expandedPath, backupSuffix);
    try {
      const output = execFileSync('ssh', [
        '-i', target.sshKeyPath,
        '-p', String(target.port || 22),
        '-o', 'ConnectTimeout=15',
        '-o', 'BatchMode=yes',
        `${target.user}@${target.host}`,
        'bash', '-s', '--', expandedPath,
      ], { input: command, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      process.stdout.write(`${id} ${output}`);
    } catch (error) {
      const detail = error.stderr?.toString().trim() || error.message;
      console.error(`${id} FAILED ${detail}`);
      process.exitCode = 1;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runMigration();
