import { describe, it, expect } from 'vitest';
import { parseSlackCommand } from '../slack/slack-commands.js';

describe('parseSlackCommand', () => {
  // ── conversations ─────────────────────────────────────────

  describe('conversations', () => {
    it('parses "conversations list"', () => {
      const result = parseSlackCommand('conversations list');
      expect(result).toEqual({ ok: true, command: { type: 'conversations_list' } });
    });

    it('parses "CONVERSATIONS LIST" (case insensitive)', () => {
      const result = parseSlackCommand('CONVERSATIONS LIST');
      expect(result).toEqual({ ok: true, command: { type: 'conversations_list' } });
    });

    it('parses "conversations clear 1234.5678"', () => {
      const result = parseSlackCommand('conversations clear 1234.5678');
      expect(result).toEqual({ ok: true, command: { type: 'conversations_clear', threadTs: '1234.5678' } });
    });

    it('fails "conversations clear" without thread_ts', () => {
      const result = parseSlackCommand('conversations clear');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('thread_ts');
    });

    it('parses "conversations cleanup 7"', () => {
      const result = parseSlackCommand('conversations cleanup 7');
      expect(result).toEqual({ ok: true, command: { type: 'conversations_cleanup', olderThanDays: 7 } });
    });

    it('fails "conversations cleanup" without days', () => {
      const result = parseSlackCommand('conversations cleanup');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('days');
    });

    it('fails "conversations cleanup abc" with non-numeric days', () => {
      const result = parseSlackCommand('conversations cleanup abc');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('abc');
    });

    it('fails "conversations cleanup 0" with zero days', () => {
      const result = parseSlackCommand('conversations cleanup 0');
      expect(result.ok).toBe(false);
    });

    it('parses "conversations status 1234.5678"', () => {
      const result = parseSlackCommand('conversations status 1234.5678');
      expect(result).toEqual({ ok: true, command: { type: 'conversations_status', threadTs: '1234.5678' } });
    });

    it('fails "conversations status" without thread_ts', () => {
      const result = parseSlackCommand('conversations status');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('thread_ts');
    });

    it('parses "conversations metrics"', () => {
      const result = parseSlackCommand('conversations metrics');
      expect(result).toEqual({ ok: true, command: { type: 'conversations_metrics' } });
    });

    it('parses "conversations inspect 1234.5678"', () => {
      const result = parseSlackCommand('conversations inspect 1234.5678');
      expect(result).toEqual({ ok: true, command: { type: 'conversations_inspect', threadTs: '1234.5678' } });
    });

    it('fails "conversations inspect" without thread_ts', () => {
      const result = parseSlackCommand('conversations inspect');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('thread_ts');
    });

    it('fails "conversations" without subcommand', () => {
      const result = parseSlackCommand('conversations');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('list');
    });

    it('fails "conversations unknown" with unknown subcommand', () => {
      const result = parseSlackCommand('conversations unknown');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('unknown');
    });
  });

  // ── edge cases ──────────────────────────────────────────

  describe('edge cases', () => {
    it('empty string returns error', () => {
      const result = parseSlackCommand('');
      expect(result.ok).toBe(false);
    });

    it('whitespace-only returns error', () => {
      const result = parseSlackCommand('   ');
      expect(result.ok).toBe(false);
    });

    it('unknown command returns error', () => {
      const result = parseSlackCommand('deploy now');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('deploy');
    });

    it('removed commands (approve, status, etc.) return error', () => {
      expect(parseSlackCommand('approve task-1').ok).toBe(false);
      expect(parseSlackCommand('status').ok).toBe(false);
      expect(parseSlackCommand('reject task-1').ok).toBe(false);
      expect(parseSlackCommand('select task-1 exp-a').ok).toBe(false);
      expect(parseSlackCommand('input task-1 hello').ok).toBe(false);
    });
  });
});
