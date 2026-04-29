import { describe, expect, it } from 'vitest';

import { shouldSkipAutoFixForError } from '../auto-fix-gating.js';

describe('auto-fix-gating', () => {
  it('does not skip auto-fix for non-string errors', () => {
    expect(shouldSkipAutoFixForError(undefined)).toBe(false);
    expect(shouldSkipAutoFixForError(null)).toBe(false);
    expect(shouldSkipAutoFixForError(42)).toBe(false);
  });

  it('skips auto-fix for workflow cancellation errors', () => {
    expect(shouldSkipAutoFixForError('Cancelled by user (workflow)')).toBe(true);
  });

  it('skips auto-fix for downstream cancellation errors', () => {
    expect(shouldSkipAutoFixForError('Cancelled: upstream task "build" was cancelled')).toBe(true);
  });

  it('skips auto-fix for task-level termination errors', () => {
    expect(shouldSkipAutoFixForError('Terminated by user')).toBe(true);
  });

  it('skips auto-fix for downstream termination errors', () => {
    expect(shouldSkipAutoFixForError('Terminated: upstream task "build" was terminated')).toBe(true);
  });

  it('does not skip auto-fix for normal failures', () => {
    expect(shouldSkipAutoFixForError('non-zero exit')).toBe(false);
    expect(shouldSkipAutoFixForError('Merge failed: CONFLICT')).toBe(false);
    expect(shouldSkipAutoFixForError('')).toBe(false);
    expect(shouldSkipAutoFixForError('cancelled by user')).toBe(false);
    expect(shouldSkipAutoFixForError('Cancel')).toBe(false);
    expect(shouldSkipAutoFixForError('Not Cancelled: warning only')).toBe(false);
  });
});
