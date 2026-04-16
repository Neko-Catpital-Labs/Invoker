import { describe, expect, it } from 'vitest';
import {
  ensureSqliteFlushDebounceForOwner,
  OWNER_SQLITE_FLUSH_DEBOUNCE_MS,
} from '../sqlite-flush-policy.js';

describe('ensureSqliteFlushDebounceForOwner', () => {
  it('sets a default debounce for writable owners', () => {
    const env: NodeJS.ProcessEnv = {};

    ensureSqliteFlushDebounceForOwner(env, false);

    expect(env.INVOKER_SQLITE_FLUSH_DEBOUNCE_MS).toBe(OWNER_SQLITE_FLUSH_DEBOUNCE_MS);
  });

  it('does not override an explicit debounce', () => {
    const env: NodeJS.ProcessEnv = { INVOKER_SQLITE_FLUSH_DEBOUNCE_MS: '1000' };

    ensureSqliteFlushDebounceForOwner(env, false);

    expect(env.INVOKER_SQLITE_FLUSH_DEBOUNCE_MS).toBe('1000');
  });

  it('does not set debounce for read-only processes', () => {
    const env: NodeJS.ProcessEnv = {};

    ensureSqliteFlushDebounceForOwner(env, true);

    expect(env.INVOKER_SQLITE_FLUSH_DEBOUNCE_MS).toBeUndefined();
  });
});
