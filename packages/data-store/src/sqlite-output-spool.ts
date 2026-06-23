/**
 * File-backed output spool helpers for {@link SQLiteAdapter}.
 *
 * These functions own the on-disk encoding and layout of streamed task output
 * (the `full` log file and the base64 `.jsonl` spool). They are pure with
 * respect to adapter state — file paths and limits are passed in — so the
 * adapter delegates to them without changing any read/write semantics.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { OutputChunk } from './sqlite-adapter.js';

/** Stable filesystem-safe key derived from a task id. */
export function taskOutputKey(taskId: string): string {
  return createHash('sha256').update(taskId).digest('hex');
}

/** Path of the diagnostic full-output log file for a task. */
export function taskOutputFilePath(outputDir: string, taskId: string): string {
  return join(outputDir, 'full', `${taskOutputKey(taskId)}.log`);
}

/** Path of the base64 JSONL streaming spool file for a task. */
export function taskSpoolFilePath(outputDir: string, taskId: string): string {
  return join(outputDir, 'spool', `${taskOutputKey(taskId)}.jsonl`);
}

/** Serialize one chunk as a `<offset>\t<base64>\n` spool line. */
export function encodeSpoolLine(chunk: OutputChunk): string {
  const data = Buffer.from(chunk.data, 'utf8').toString('base64');
  return `${chunk.offset}\t${data}\n`;
}

/** Parse one spool line back into a chunk, or null if malformed/empty. */
export function decodeSpoolLine(line: string): OutputChunk | null {
  if (!line) return null;
  const separator = line.indexOf('\t');
  if (separator <= 0) return null;
  const offset = Number.parseInt(line.slice(0, separator), 10);
  if (!Number.isFinite(offset)) return null;
  return {
    offset,
    data: Buffer.from(line.slice(separator + 1), 'base64').toString('utf8'),
  };
}

/** Read every chunk from a spool file in file order. */
export function readSpoolLinesFromFile(file: string): OutputChunk[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => decodeSpoolLine(line))
    .filter((chunk): chunk is OutputChunk => chunk !== null);
}

/** Read up to `limit` trailing chunks from a spool file without loading it whole. */
export function readLastSpoolLinesFromFile(file: string, limit: number): OutputChunk[] {
  if (limit <= 0) return [];
  if (!existsSync(file)) return [];

  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const chunkSize = 64 * 1024;
    let position = size;
    let suffix = '';
    let lines: string[] = [];

    while (position > 0 && lines.length <= limit) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      readSync(fd, buffer, 0, readSize, position);
      const text = buffer.toString('utf8') + suffix;
      const parts = text.split('\n');
      suffix = parts.shift() ?? '';
      lines = parts.concat(lines);
    }
    if (position === 0 && suffix) {
      lines.unshift(suffix);
    }

    return lines
      .filter(Boolean)
      .slice(-limit)
      .map((line) => decodeSpoolLine(line))
      .filter((chunk): chunk is OutputChunk => chunk !== null);
  } finally {
    closeSync(fd);
  }
}
