import { execFile } from 'node:child_process';

import { IpcInvokerClient } from '@invoker/slack-manager/src/invoker-client.js';

import { createInvokerWatcher } from './invoker-watcher.js';

function readDurationEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number of milliseconds`);
  }
  return value;
}

function makeLog(): (level: string, message: string) => void {
  return (level, message) => {
    const line = `[watcher] ${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
    if (level === 'error') console.error(line);
    else console.log(line);
  };
}

function restartService(service: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['--user', 'restart', service], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  const log = makeLog();
  const service = process.env.INVOKER_WATCHER_RESTART_SERVICE ?? 'slack-manager.service';
  const client = new IpcInvokerClient({
    spawnInvoker: () => {},
    log,
  });
  const watcher = createInvokerWatcher({
    client,
    restart: () => restartService(service),
    log,
    pollIntervalMs: readDurationEnv('INVOKER_WATCHER_POLL_INTERVAL_MS'),
    downThresholdMs: readDurationEnv('INVOKER_WATCHER_DOWN_THRESHOLD_MS'),
    restartCooldownMs: readDurationEnv('INVOKER_WATCHER_RESTART_COOLDOWN_MS'),
  });

  const shutdown = (): void => {
    watcher.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  watcher.start();
}

void main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[watcher] fatal: ${message}`);
  process.exit(1);
});
