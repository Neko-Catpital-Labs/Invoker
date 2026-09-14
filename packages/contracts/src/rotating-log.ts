import { appendFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';

export const LOG_ROTATE_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_SHARD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const SHARD_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+(?:-\d+)?$/;

export interface AppendRotatingLogLineOptions {
  maxBytes?: number;
  now?: Date;
}

export interface PurgeOldLogShardsOptions {
  maxAgeMs?: number;
  nowMs?: number;
}

function splitLogName(name: string): { stem: string; ext: string } {
  const ext = path.extname(name);
  return { stem: name.slice(0, name.length - ext.length), ext };
}

function shardPath(filePath: string, now: Date): string {
  const dir = path.dirname(filePath);
  const { stem, ext } = splitLogName(path.basename(filePath));
  const stamp = `${now.toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  let candidate = path.join(dir, `${stem}.${stamp}${ext}`);
  for (let n = 1; existsSync(candidate); n += 1) {
    candidate = path.join(dir, `${stem}.${stamp}-${n}${ext}`);
  }
  return candidate;
}

export function isRotatedLogShard(activeName: string, candidate: string): boolean {
  const { stem, ext } = splitLogName(activeName);
  if (candidate === activeName) return false;
  if (!candidate.startsWith(`${stem}.`) || !candidate.endsWith(ext)) return false;
  return SHARD_STAMP.test(candidate.slice(stem.length + 1, candidate.length - ext.length));
}

export function appendRotatingLogLine(
  filePath: string,
  line: string,
  options: AppendRotatingLogLineOptions = {},
): void {
  const maxBytes = options.maxBytes ?? LOG_ROTATE_MAX_BYTES;
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
    try {
      renameSync(filePath, shardPath(filePath, options.now ?? new Date()));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  appendFileSync(filePath, line);
}

export function purgeOldLogShards(dir: string, options: PurgeOldLogShardsOptions = {}): string[] {
  const maxAgeMs = options.maxAgeMs ?? LOG_SHARD_MAX_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.warn(`[rotating-log] could not list ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    const dot = name.indexOf('.');
    if (dot <= 0) continue;
    const activeName = `${name.slice(0, dot)}${path.extname(name)}`;
    if (!isRotatedLogShard(activeName, name)) continue;
    const shard = path.join(dir, name);
    try {
      if (nowMs - statSync(shard).mtimeMs < maxAgeMs) continue;
      rmSync(shard, { force: true });
      removed.push(shard);
    } catch (err) {
      console.warn(`[rotating-log] could not purge ${shard}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return removed.sort();
}
