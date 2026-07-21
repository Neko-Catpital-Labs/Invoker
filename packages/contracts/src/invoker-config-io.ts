import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type InvokerConfigRecord = Record<string, unknown>;

export const INVOKER_CONFIG_FILE_MODE = 0o600;

let tempCounter = 0;

function isJsonRecord(value: unknown): value is InvokerConfigRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readInvokerConfigFile(configPath: string): InvokerConfigRecord {
  if (!existsSync(configPath)) return {};

  const raw = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Invoker config JSON at ${configPath}: ${message}`);
  }

  if (!isJsonRecord(parsed)) {
    throw new Error(`Invalid Invoker config at ${configPath}: expected a JSON object`);
  }

  return parsed;
}

export function invokerConfigBackupPath(configPath: string): string {
  return `${configPath}.bak`;
}

function nextTempPath(configPath: string): string {
  tempCounter += 1;
  return join(dirname(configPath), `.${process.pid}-${tempCounter}.config.tmp`);
}

export function writeInvokerConfigFile(configPath: string, config: InvokerConfigRecord): string {
  mkdirSync(dirname(configPath), { recursive: true });

  const tempPath = nextTempPath(configPath);
  try {
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: INVOKER_CONFIG_FILE_MODE });
    chmodSync(tempPath, INVOKER_CONFIG_FILE_MODE);
    if (existsSync(configPath)) {
      const backupPath = invokerConfigBackupPath(configPath);
      copyFileSync(configPath, backupPath);
      chmodSync(backupPath, INVOKER_CONFIG_FILE_MODE);
    }
    renameSync(tempPath, configPath);
  } finally {
    rmSync(tempPath, { force: true });
  }

  return configPath;
}

export function updateInvokerConfigFile(
  configPath: string,
  mutate: (config: InvokerConfigRecord) => void,
): string {
  const config = readInvokerConfigFile(configPath);
  mutate(config);
  return writeInvokerConfigFile(configPath, config);
}
