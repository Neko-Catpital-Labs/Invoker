import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';

const mainTsSource = readFileSync(resolve(__dirname, '../main.ts'), 'utf8');

function extractBlock(source: string, startMarker: string, fromIndex = 0): string {
  const start = source.indexOf(startMarker, fromIndex);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  let depth = 0;
  let i = source.indexOf('{', start);
  const bodyStart = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces after marker: ${startMarker}`);
}

describe('GUI onBeforeQuit requeueRunningWorkflowMutationIntents guard', () => {
  it('gates the requeue call on ownerMode, matching the existing owner-only persistence idiom in this function', () => {
    const onBeforeQuitBody = extractBlock(mainTsSource, 'onBeforeQuit: async (event) => {');

    const requeueIdx = onBeforeQuitBody.indexOf('persistence.requeueRunningWorkflowMutationIntents();');
    expect(requeueIdx, 'requeueRunningWorkflowMutationIntents call not found in onBeforeQuit').toBeGreaterThan(-1);

    const persistenceGuardStart = onBeforeQuitBody.lastIndexOf('if (persistence) {', requeueIdx);
    expect(persistenceGuardStart, 'enclosing if (persistence) guard not found').toBeGreaterThan(-1);

    const persistenceBlock = extractBlock(onBeforeQuitBody, 'if (persistence) {', persistenceGuardStart);
    const ownerModeMarkerIdx = persistenceBlock.indexOf('if (ownerMode) {');
    expect(ownerModeMarkerIdx, 'if (ownerMode) guard not found around the requeue call').toBeGreaterThan(-1);

    const ownerModeBlock = extractBlock(persistenceBlock, 'if (ownerMode) {');
    expect(ownerModeBlock).toContain('persistence.requeueRunningWorkflowMutationIntents();');

    const ownerModeBodyStart = persistenceBlock.indexOf('{', ownerModeMarkerIdx);
    const ownerModeBlockEnd = ownerModeBodyStart + ownerModeBlock.length;

    const closeIdx = persistenceBlock.indexOf('persistence.close();');
    expect(closeIdx, 'persistence.close() not found alongside the requeue call').toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThanOrEqual(ownerModeBlockEnd);
  });

  it('confirms the underlying guard is real: a read-only SQLiteAdapter throws when requeueRunningWorkflowMutationIntents is called directly', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gui-before-quit-readonly-'));
    const dbPath = join(tmpDir, 'test.db');
    try {
      const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      owner.close();

      const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
      expect(() => reader.requeueRunningWorkflowMutationIntents()).toThrow(/read-only/i);
      reader.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
