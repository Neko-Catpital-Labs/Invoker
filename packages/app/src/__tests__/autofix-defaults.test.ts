import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUTO_APPROVE_AI_FIXES,
  DEFAULT_AUTO_FIX_RETRIES,
  resolveAutoApproveAIFixes,
  resolveAutoFixRetries,
} from '../autofix-defaults.js';

describe('resolveAutoFixRetries', () => {
  it('returns DEFAULT_AUTO_FIX_RETRIES when the key is unset', () => {
    expect(DEFAULT_AUTO_FIX_RETRIES).toBe(3);
    expect(resolveAutoFixRetries({})).toBe(3);
  });

  it('returns DEFAULT_AUTO_FIX_RETRIES when the key is null', () => {
    expect(resolveAutoFixRetries({ autoFixRetries: null as unknown as number })).toBe(3);
  });

  it('honors an explicit 0 as user opt-out', () => {
    expect(resolveAutoFixRetries({ autoFixRetries: 0 })).toBe(0);
  });

  it('honors positive finite numbers verbatim', () => {
    expect(resolveAutoFixRetries({ autoFixRetries: 1 })).toBe(1);
    expect(resolveAutoFixRetries({ autoFixRetries: 5 })).toBe(5);
  });

  it('falls back to the default for negative or non-finite numbers', () => {
    expect(resolveAutoFixRetries({ autoFixRetries: -1 })).toBe(3);
    expect(resolveAutoFixRetries({ autoFixRetries: Number.NaN })).toBe(3);
    expect(resolveAutoFixRetries({ autoFixRetries: Number.POSITIVE_INFINITY })).toBe(3);
  });

  it('falls back to the default for non-numeric values', () => {
    expect(resolveAutoFixRetries({ autoFixRetries: 'three' as unknown as number })).toBe(3);
  });
});

describe('resolveAutoApproveAIFixes', () => {
  it('returns DEFAULT_AUTO_APPROVE_AI_FIXES when the key is unset', () => {
    expect(DEFAULT_AUTO_APPROVE_AI_FIXES).toBe(true);
    expect(resolveAutoApproveAIFixes({})).toBe(true);
  });

  it('returns DEFAULT_AUTO_APPROVE_AI_FIXES when the key is null', () => {
    expect(resolveAutoApproveAIFixes({ autoApproveAIFixes: null as unknown as boolean })).toBe(true);
  });

  it('honors an explicit false as user opt-out', () => {
    expect(resolveAutoApproveAIFixes({ autoApproveAIFixes: false })).toBe(false);
  });

  it('honors an explicit true', () => {
    expect(resolveAutoApproveAIFixes({ autoApproveAIFixes: true })).toBe(true);
  });

  it('falls back to the default for non-boolean values', () => {
    expect(resolveAutoApproveAIFixes({ autoApproveAIFixes: 1 as unknown as boolean })).toBe(true);
    expect(resolveAutoApproveAIFixes({ autoApproveAIFixes: 'yes' as unknown as boolean })).toBe(true);
  });
});
