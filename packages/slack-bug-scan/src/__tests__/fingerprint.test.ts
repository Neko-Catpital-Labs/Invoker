import { describe, expect, it } from 'vitest';
import { issueFingerprint, normalizeComplaintText } from '../fingerprint.js';

describe('normalizeComplaintText', () => {
  it('strips slack mrkdwn tags', () => {
    expect(normalizeComplaintText('<@U123> the login button is <b>broken</b>'))
      .toBe('the login button is broken');
  });

  it('strips urls', () => {
    expect(normalizeComplaintText('see https://example.com/log for the trace'))
      .toBe('see for the trace');
  });

  it('collapses whitespace and lowercases', () => {
    expect(normalizeComplaintText('  The   Login  Button\nIs Broken  ')).toBe('the login button is broken');
  });
});

describe('issueFingerprint', () => {
  it('is stable for the same text', () => {
    expect(issueFingerprint('the login button is broken')).toBe(issueFingerprint('the login button is broken'));
  });

  it('is stable across cosmetic differences (case, whitespace, mentions)', () => {
    const a = issueFingerprint('The login button is broken');
    const b = issueFingerprint('  the   login button is broken  ');
    const c = issueFingerprint('<@U1> the login button is broken');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('differs for genuinely different complaints', () => {
    expect(issueFingerprint('the login button is broken'))
      .not.toBe(issueFingerprint('the logout button crashes the app'));
  });

  it('returns a 16-character lowercase hex string', () => {
    const fp = issueFingerprint('anything');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});
