import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';

function checkpointTimingLines(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('"operation":"wal_checkpoint"'));
}

describe('SQLiteAdapter checkpoint timing log', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function openAdapter(options: { logCheckpointTiming?: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), 'checkpoint-timing-'));
    dirs.push(dir);
    return SQLiteAdapter.create(join(dir, 'invoker.db'), { ownerCapability: true, ...options });
  }

  it('prints start and end timing lines by default', async () => {
    const adapter = await openAdapter({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    adapter.checkpointWal('PASSIVE');
    const events = checkpointTimingLines(warn).map((line) => JSON.parse(line).event);
    adapter.close();
    expect(events).toEqual(['start', 'end']);
  });

  it('prints no timing lines when logCheckpointTiming is false', async () => {
    const adapter = await openAdapter({ logCheckpointTiming: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    adapter.checkpointWal('PASSIVE');
    const lines = checkpointTimingLines(warn);
    adapter.close();
    expect(lines).toEqual([]);
  });
});
