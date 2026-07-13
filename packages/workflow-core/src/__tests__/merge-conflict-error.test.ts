import { describe, expect, it } from 'vitest';
import { parseMergeConflictError } from '../merge-conflict-error.js';

describe('parseMergeConflictError', () => {
  it('parses merge-conflict JSON payloads', () => {
    expect(parseMergeConflictError(JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'experiment/foo',
      conflictFiles: ['src/foo.ts'],
    }))).toEqual({
      failedBranch: 'experiment/foo',
      conflictFiles: ['src/foo.ts'],
    });
  });

  it('parses wrapped JSON tails', () => {
    expect(parseMergeConflictError([
      '[Fix with Agent failed] boom',
      '',
      JSON.stringify({
        type: 'merge_conflict',
        failedBranch: 'experiment/foo',
        conflictFiles: ['src/foo.ts'],
      }),
    ].join('\n'))).toEqual({
      failedBranch: 'experiment/foo',
      conflictFiles: ['src/foo.ts'],
    });
  });

  it('parses wrapped local executor startup text', () => {
    expect(parseMergeConflictError(
      'Executor startup failed (ssh): Merge conflict merging experiment/foo: packages/app/src/headless.ts, packages/app/src/main.ts',
    )).toEqual({
      failedBranch: 'experiment/foo',
      conflictFiles: ['packages/app/src/headless.ts', 'packages/app/src/main.ts'],
    });
  });

  it('parses SSH remote merge-conflict text', () => {
    expect(parseMergeConflictError([
      'Merge conflict merging upstream branch "experiment/foo" on remote.',
      'Conflicting files:',
      'packages/app/src/headless.ts',
      'packages/app/src/main.ts',
    ].join('\n'))).toEqual({
      failedBranch: 'experiment/foo',
      conflictFiles: ['packages/app/src/headless.ts', 'packages/app/src/main.ts'],
    });
  });

  it('ignores conflict-looking text without recoverable metadata', () => {
    expect(parseMergeConflictError(
      'CONFLICT (content): Merge conflict in src/foo.ts\nAutomatic merge failed; fix conflicts and then commit the result.',
    )).toBeUndefined();
  });
});
