import { describe, it, expect } from 'vitest';
import { normalizeMergeModeForPersistence } from '../merge-mode.js';

describe('normalizeMergeModeForPersistence', () => {
  it('maps external_review to external_review', () => {
    expect(normalizeMergeModeForPersistence('external_review')).toBe('external_review');
  });

  it('passes through manual and automatic', () => {
    expect(normalizeMergeModeForPersistence('manual')).toBe('manual');
    expect(normalizeMergeModeForPersistence('automatic')).toBe('automatic');
  });

  it('rejects unknown labels', () => {
    expect(() => normalizeMergeModeForPersistence('github')).toThrow(/Invalid mergeMode/);
    expect(() => normalizeMergeModeForPersistence('gitlab')).toThrow(/Invalid mergeMode/);
  });
});
